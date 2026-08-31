/**
 * PrizeLayer draw verifier — a complete, independent reimplementation of the two algorithms that
 * decide what a player won.
 *
 * This file is deliberately the whole library. It has no dependencies, no build step beyond
 * `tsc`, and no imports at all: everything it needs is `globalThis.crypto.subtle`, which is
 * identical in Node 22 and in every modern browser (including pages opened from `file://`, which
 * browsers treat as a secure context). One code path, one file — a skeptic can read all of it.
 *
 * It verifies TWO things, and the second is the one that matters:
 *
 *  1. **The draw.** SHA-256(server seed) matches the commitment published before play; then the
 *     HMAC-SHA256 derivation of `specs/rng-fairness.md` §3 reproduces the ppm value `v`; then §4's
 *     cumulative lookup maps `v` onto a slot.
 *
 *  2. **The odds themselves.** The slot probabilities are NOT covered by the prize-table snapshot
 *     hash — they exist only inside the `edition_fingerprint` preimage. A verifier that accepted a
 *     published odds table on trust would confirm honest arithmetic over unverified numbers, which
 *     proves nothing: any table could be served after the fact. So this library rebuilds the
 *     canonical edition bytes itself and checks the fingerprint against the one recorded on the win.
 *
 * If the fingerprint check fails, the slot result is meaningless even when it happens to match.
 * {@link verify} therefore reports every check but only returns `ok` when all of them pass.
 *
 * Everything is async because Web Crypto is async. There is no synchronous variant, on purpose:
 * a second code path is a second thing to audit.
 */

// ---------------------------------------------------------------------------
// Normative constants — rng-fairness.md §1. These are the rules a draw ran under.
// ---------------------------------------------------------------------------

/** Server seed length: 32 bytes of CSPRNG output. The HMAC key is these raw bytes. */
export const SERVER_SEED_BYTES = 32;

/**
 * Largest multiple of 1,000,000 at or below 2^32. Chunks at or above it are rejected.
 *
 * This is what makes the draw uniform rather than nearly uniform: 2^32 is not a multiple of
 * 1,000,000, so a bare `mod` would over-represent low ppm values. Discarding the short tail leaves
 * a range 1,000,000 divides exactly.
 */
export const ACCEPTANCE_THRESHOLD = 4_294_000_000;

/** Big-endian 4-byte chunk offsets, tried in exactly this order. */
export const CHUNK_OFFSETS: readonly number[] = [0, 4, 8, 12, 16, 20, 24, 28];

/** Parts per million: the odds unit. A full prize table sums to exactly this. */
export const PPM_TOTAL = 1_000_000;

/** Domain byte prefixing the `edition_fingerprint` preimage. */
export const EDITION_DOMAIN_BYTE = 0x01;

/**
 * Domain byte of the snapshot preimage — the one that binds a slot to the ITEM that filled it.
 * Distinct from {@link EDITION_DOMAIN_BYTE} so the two preimages can never be confused for one
 * another even if every following byte happened to coincide.
 */
export const SNAPSHOT_DOMAIN_BYTE = 0x03;

/** Client seeds are constrained by rng-fairness.md §2, which keeps the HMAC message pure ASCII. */
const CLIENT_SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One slot's frozen numbers, as they appear in the fingerprinted edition.
 *
 * The cents fields are `bigint`, not `number`, and that is not fussiness: they are signed 64-bit
 * on the wire and exceed `Number.MAX_SAFE_INTEGER`. A JSON numeric literal would be rounded by
 * `JSON.parse` before any code here saw it, producing different canonical bytes and therefore a
 * different fingerprint — a silent wrong answer rather than an error. Use {@link parseEdition}.
 *
 * `requiredBuyBackRateBps` and `requiredCategory` exist on the published edition but are
 * deliberately NOT part of this preimage; including them yields a different, wrong fingerprint.
 */
export interface SlotOdds {
  slotIndex: number;
  probabilityPpm: number;
  requiredBuyBackValueCents: bigint;
  requiredMarketValueCents: bigint;
}

/** An edition's frozen maths — exactly the fields the `0x01` preimage covers, and no others. */
export interface Edition {
  /** UUID, canonical hyphenated form. Hashed as its 16 raw bytes, most-significant half first. */
  engineId: string;
  engineVersion: number;
  priceCents: bigint;
  slots: SlotOdds[];
}

/**
 * One slot's display fact, as pinned by the `0x03` snapshot preimage.
 *
 * `displayedValueCents` is `bigint` for the same reason the edition's cents fields are. See
 * {@link parseSnapshotBody} before parsing a published body by hand.
 */
export interface SnapshotSlot {
  slotIndex: number;
  /** The item that filled this slot, as a canonical hyphenated UUID. */
  currentItemId: string;
  displayedValueCents: bigint;
  /** The label/media reference shown for the slot. May be empty. Hashed as UTF-8 BYTES. */
  displayedMedia: string;
}

/**
 * A published prize-table snapshot: which item sat in which slot, and at what displayed value.
 *
 * `editionFingerprint` is not decoration — the preimage opens with its raw 32 bytes, so a
 * snapshot is cryptographically bound to one edition's maths. {@link verify} checks that the
 * fingerprint here is the one it recomputed from the edition, which is what makes the two
 * preimages one chain rather than two unrelated hashes.
 */
export interface Snapshot {
  /** 64 lowercase hex characters — the edition digest this snapshot was built over. */
  editionFingerprint: string;
  slots: SnapshotSlot[];
}

/** One chunk the derivation loop discarded, located by the HMAC it came from and its offset. */
export interface RejectedChunk {
  attempt: number;
  offset: number;
  chunk: number;
}

/** The full, replayable story of one derivation — everything §3 did to reach `value`. */
export interface Derivation {
  /** The accepted ppm value `v`, in [0, 999999]. */
  value: number;
  attempt: number;
  offset: number;
  /** The chunks rejected before the accepted one, in loop order. Empty for an offset-0 accept. */
  rejected: RejectedChunk[];
  /** The ASCII message of the ACCEPTED attempt. */
  message: string;
  /** The HMAC of the accepted attempt, lowercase hex. */
  hmacHex: string;
  acceptedChunk: number;
}

/** Everything needed to verify one open. Assemble it from the published verification data. */
export interface VerificationInput {
  /** The revealed server seed, 64 lowercase hex characters. Only exists after the pair retires. */
  serverSeedHex: string;
  /** The commitment published BEFORE play. This is the promise being checked. */
  commitmentHex: string;
  clientSeed: string;
  nonce: number;
  edition: Edition;
  /**
   * The published prize-table snapshot, if you have it.
   *
   * OPTIONAL, and its absence is reported rather than ignored: without it the chain stops at a
   * slot NUMBER. You would have proved you legitimately won position `i` at its honest odds, and
   * nothing at all about what was in position `i`. When omitted, {@link VerificationReport.caveats}
   * says so in as many words.
   */
  snapshot?: Snapshot;
  /** What the platform says happened. Every field here is a claim this library tries to refute. */
  expected: {
    editionFingerprint: string;
    drawnPpmValue: number;
    drawnSlotIndex: number;
    /** The `snapshot_hash` recorded on the win. Required when {@link VerificationInput.snapshot} is given. */
    snapshotHash?: string;
    /** The item id the platform says you received. Required when {@link VerificationInput.snapshot} is given. */
    itemId?: string;
  };
}

/** One claim, checked. `expected` is what we were told; `computed` is what the maths says. */
export interface Check {
  ok: boolean;
  expected: string;
  computed: string;
}

/** The verdict, with enough detail to see exactly where a failing verification diverged. */
export interface VerificationReport {
  /** True only when every check passes. A single failure invalidates the whole verification. */
  ok: boolean;
  checks: {
    /** SHA-256(revealed seed) equals the commitment published before play. */
    commitment: Check;
    /** The published odds are the odds that were fingerprinted. Without this the rest is theatre. */
    editionFingerprint: Check;
    /** The derivation reproduces the recorded ppm value. */
    drawnPpmValue: Check;
    /** The cumulative lookup reproduces the recorded slot. */
    drawnSlotIndex: Check;
    /** The published snapshot body reproduces the `snapshot_hash` on the win. Absent if no snapshot was given. */
    snapshotHash?: Check;
    /**
     * The snapshot is bound to THIS edition — its embedded fingerprint is the one recomputed from
     * the odds. Without this a valid snapshot of some *other* edition would sail through.
     */
    snapshotEditionLink?: Check;
    /** The item recorded on the win is the item the snapshot places in the drawn slot. */
    drawnItemId?: Check;
  };
  trace: Derivation & {
    /** The canonical `0x01` edition preimage, lowercase hex — the exact bytes that were hashed. */
    editionPreimageHex: string;
    computedEditionFingerprint: string;
    computedSlotIndex: number;
    /** The canonical `0x03` snapshot preimage, lowercase hex. Absent if no snapshot was given. */
    snapshotPreimageHex?: string;
    computedSnapshotHash?: string;
    /** The item the snapshot places in the slot the maths selected. */
    itemIdInDrawnSlot?: string;
  };
  /**
   * What this run did NOT prove, in plain language.
   *
   * A verifier that only ever prints green is not a verifier, and one that stays silent about the
   * links it never checked is worse — it converts an unexamined claim into an apparent proof.
   * Show these next to any PASS.
   */
  caveats: string[];
  /** A one-line human summary, safe to show a player verbatim. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

/** Decode lowercase or uppercase hex. Throws on odd length or any non-hex character. */
export function bytesFromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex must have an even length, was ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    // Character-checked before decoding, not after: parseInt tolerates trailing junk and only
    // returns NaN when the FIRST character is bad, so '0x' would otherwise decode happily as 0.
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) {
      throw new Error(`not a hex pair at index ${i * 2}: '${pair}'`);
    }
    out[i] = Number.parseInt(pair, 16);
  }
  return out;
}

/** Encode as lowercase hex — the form every digest in the platform is recorded in. */
export function hexFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Crypto — the only two primitives this library uses.
// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      'Web Crypto is unavailable. Node 18+ or a browser in a secure context (https, localhost, ' +
        'or a local file) is required.',
    );
  }
  return c.subtle;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', toBuffer(bytes)));
}

/** HMAC-SHA256 keyed with the RAW seed bytes — never with the hex string that displays them. */
export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const handle = await subtle().importKey(
    'raw',
    toBuffer(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle().sign('HMAC', handle, toBuffer(message)));
}

/** The commitment published before play: SHA-256 over the raw seed bytes, lowercase hex. */
export async function commitment(serverSeed: Uint8Array): Promise<string> {
  requireSeed(serverSeed);
  return hexFromBytes(await sha256(serverSeed));
}

/**
 * Web Crypto wants an ArrayBuffer. A `Uint8Array` may be a view onto a larger buffer, so slicing
 * to its own bounds is what keeps a subarray from silently hashing its neighbours' bytes too.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// The draw — rng-fairness.md §3
// ---------------------------------------------------------------------------

/** The ASCII HMAC message: `<clientSeed>:<nonce>:<attempt>`, with attempt spelled out from 0. */
export function drawMessage(clientSeed: string, nonce: number, attempt: number): Uint8Array {
  requireClientSeed(clientSeed);
  requireNonce(nonce);
  return new TextEncoder().encode(`${clientSeed}:${nonce}:${attempt}`);
}

/**
 * The 4 bytes at `offset`, big-endian, as an unsigned 32-bit value.
 *
 * Note the multiplication rather than `<< 24`. JavaScript's bitwise operators coerce to SIGNED
 * 32-bit, so `bytes[offset] << 24` turns negative for any byte above 0x7f — and the values that
 * flips are precisely the large ones near the rejection threshold, so the bug would hide until it
 * changed somebody's prize.
 */
export function bigEndianUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error(`offset ${offset} is out of range for ${bytes.length} bytes`);
  }
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

/**
 * The normative derivation loop. Walks the eight big-endian chunks of each HMAC in order, taking
 * the first below {@link ACCEPTANCE_THRESHOLD}.
 *
 * If all eight are rejected the loop moves to the next attempt, which is why `attempt` is part of
 * the message. That branch has probability ~6.6e-30 and no golden vector can ever exist for it, so
 * it is implemented from the specification and reviewed rather than tested. It is bounded in
 * practice by the HMAC output itself, not by input, so no iteration cap is imposed here — adding
 * one would be a deviation from the certified engine.
 */
export async function derive(
  serverSeed: Uint8Array,
  clientSeed: string,
  nonce: number,
): Promise<Derivation> {
  requireSeed(serverSeed);
  requireClientSeed(clientSeed);
  requireNonce(nonce);

  const rejected: RejectedChunk[] = [];
  for (let attempt = 0; ; attempt++) {
    const message = drawMessage(clientSeed, nonce, attempt);
    const hmac = await hmacSha256(serverSeed, message);

    for (const offset of CHUNK_OFFSETS) {
      const chunk = bigEndianUint32(hmac, offset);
      if (chunk < ACCEPTANCE_THRESHOLD) {
        return {
          value: chunk % PPM_TOTAL,
          attempt,
          offset,
          rejected,
          message: new TextDecoder().decode(message),
          hmacHex: hexFromBytes(hmac),
          acceptedChunk: chunk,
        };
      }
      rejected.push({ attempt, offset, chunk });
    }
  }
}

// ---------------------------------------------------------------------------
// The prize table — rng-fairness.md §4
// ---------------------------------------------------------------------------

/**
 * Map an accepted ppm value onto its slot: the slot `i` where `cum_{i-1} <= v < cum_i`.
 *
 * The comparison is STRICTLY less-than. A `v` landing exactly on a cumulative bound belongs to the
 * NEXT slot, and a slot carrying zero probability can never be selected. Both are pinned by golden
 * vectors because both are invisible in the ppm value itself: an implementation can reproduce
 * every HMAC correctly and still hand the player the wrong prize.
 *
 * Slots are sorted by `slotIndex` here — the order they arrive in is never trusted.
 */
export function slotFor(v: number, slots: readonly Pick<SlotOdds, 'slotIndex' | 'probabilityPpm'>[]): number {
  if (!Number.isInteger(v) || v < 0 || v >= PPM_TOTAL) {
    throw new Error(`ppm value must be an integer in [0, ${PPM_TOTAL - 1}], was ${v}`);
  }
  const sorted = sortedSlots(slots);

  let cumulative = 0;
  for (const slot of sorted) {
    cumulative += slot.probabilityPpm;
    if (v < cumulative) return slot.slotIndex;
  }
  /* Unreachable: the table sums to PPM_TOTAL and v < PPM_TOTAL, both checked above. */
  throw new Error(`ppm value ${v} exceeded the prize table's cumulative total`);
}

/**
 * Sort ascending and validate the table's shape: indices are `0..n-1` with no gaps or duplicates,
 * probabilities are non-negative and sum to exactly {@link PPM_TOTAL}.
 *
 * The contiguity check is what lets a slot's position and its `slotIndex` be used interchangeably,
 * which the cumulative lookup relies on. A table failing it is malformed, not merely unusual.
 */
function sortedSlots<T extends Pick<SlotOdds, 'slotIndex' | 'probabilityPpm'>>(slots: readonly T[]): T[] {
  if (slots.length === 0) throw new Error('a prize table must have at least one slot');

  const sorted = [...slots].sort((a, b) => a.slotIndex - b.slotIndex);
  let sum = 0;
  sorted.forEach((slot, position) => {
    if (slot.slotIndex !== position) {
      throw new Error(`slot indices must be 0..${sorted.length - 1} with no gaps or duplicates`);
    }
    if (!Number.isInteger(slot.probabilityPpm) || slot.probabilityPpm < 0 || slot.probabilityPpm > PPM_TOTAL) {
      throw new Error(`probabilityPpm must be an integer in [0, ${PPM_TOTAL}], was ${slot.probabilityPpm}`);
    }
    sum += slot.probabilityPpm;
  });
  if (sum !== PPM_TOTAL) {
    throw new Error(`prize table probabilities must sum to ${PPM_TOTAL}, was ${sum}`);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// The edition fingerprint — the `0x01` canonical preimage
// ---------------------------------------------------------------------------

/**
 * The canonical byte preimage of an edition's maths. Fixed-width big-endian integers, signed
 * cents in two's complement, no floats, no JSON, no text encoding of numbers:
 *
 * ```
 * version    : 1 byte = 0x01
 * engineId   : 16 bytes, raw UUID, most-significant half first
 * engineVer  : u32 BE
 * priceCents : i64 BE, signed
 * slotCount  : u32 BE
 * per slot, ASCENDING slotIndex:
 *   slotIndex                 : u32 BE
 *   probabilityPpm            : u32 BE
 *   requiredBuyBackValueCents : i64 BE, signed
 *   requiredMarketValueCents  : i64 BE, signed
 * ```
 *
 * The `slotCount` length prefix is why two editions with different slot counts can never collide.
 */
export function editionBytes(edition: Edition): Uint8Array {
  const out: number[] = [EDITION_DOMAIN_BYTE];

  writeUuid(out, edition.engineId);
  writeU32(out, edition.engineVersion, 'engineVersion');
  writeI64(out, edition.priceCents);

  const slots = sortedSlots(edition.slots);
  writeU32(out, slots.length, 'slotCount');
  for (const slot of slots) {
    writeU32(out, slot.slotIndex, 'slotIndex');
    writeU32(out, slot.probabilityPpm, 'probabilityPpm');
    writeI64(out, slot.requiredBuyBackValueCents);
    writeI64(out, slot.requiredMarketValueCents);
  }
  return new Uint8Array(out);
}

/** SHA-256 of {@link editionBytes}, lowercase hex — the value recorded on the win. */
export async function editionFingerprint(edition: Edition): Promise<string> {
  return hexFromBytes(await sha256(editionBytes(edition)));
}

function writeU32(out: number[], value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${field} must be an unsigned 32-bit integer, was ${value}`);
  }
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

/** Signed 64-bit, two's complement, big-endian. `asUintN` is what makes negatives encode right. */
function writeI64(out: number[], value: bigint): void {
  if (typeof value !== 'bigint') {
    throw new TypeError(`i64 fields must be bigint, was ${typeof value} — see parseEdition`);
  }
  if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) {
    throw new Error(`value ${value} does not fit in a signed 64-bit integer`);
  }
  const unsigned = BigInt.asUintN(64, value);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    out.push(Number((unsigned >> shift) & 0xffn));
  }
}

/** A UUID's 16 raw bytes. The hyphenated text form is just a rendering of exactly these bytes. */
function writeUuid(out: number[], uuid: string, field = 'engineId'): void {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`${field} must be a 16-byte UUID, got '${uuid}'`);
  }
  out.push(...bytesFromHex(hex));
}

// ---------------------------------------------------------------------------
// The snapshot content address — the `0x03` canonical preimage
// ---------------------------------------------------------------------------

/**
 * The canonical byte preimage of a prize-table snapshot — what `snapshot_hash` is taken over:
 *
 * ```
 * domain            : 1 byte = 0x03
 * editionFingerprint: 32 bytes, the hex-DECODED digest (not its 64 ASCII characters)
 * slotCount         : u32 BE
 * per slot, ASCENDING slotIndex:
 *   slotIndex           : u32 BE
 *   currentItemId       : 16 bytes, raw UUID, most-significant half first
 *   displayedValueCents : i64 BE, signed
 *   displayedMedia      : u32 BE byte-length prefix + UTF-8 bytes
 * ```
 *
 * `displayedMedia` is the only variable-width field in either preimage, and it is where a
 * JavaScript implementation goes wrong: the prefix counts UTF-8 **bytes**, while `String.length`
 * counts UTF-16 code units. They agree for ASCII and diverge for everything else, so the mistake
 * passes every ASCII test. {@link https://github.com/prizelayer/verifier} pins a multi-byte vector
 * for exactly this reason — see the `multi-byte-displayed-media` case in the fixture.
 *
 * Slots are sorted by `slotIndex`; caller order is never trusted, as in {@link editionBytes}.
 */
export function snapshotBytes(snapshot: Snapshot): Uint8Array {
  const out: number[] = [SNAPSHOT_DOMAIN_BYTE];

  const fingerprint = snapshot.editionFingerprint.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(`editionFingerprint must be 64 hex characters, was '${snapshot.editionFingerprint}'`);
  }
  out.push(...bytesFromHex(fingerprint));

  const slots = sortedSnapshotSlots(snapshot.slots);
  writeU32(out, slots.length, 'slotCount');
  for (const slot of slots) {
    writeU32(out, slot.slotIndex, 'slotIndex');
    writeUuid(out, slot.currentItemId, 'currentItemId');
    writeI64(out, slot.displayedValueCents);
    writeUtf8(out, slot.displayedMedia);
  }
  return new Uint8Array(out);
}

/** SHA-256 of {@link snapshotBytes}, lowercase hex — the `snapshot_hash` recorded on the win. */
export async function snapshotHash(snapshot: Snapshot): Promise<string> {
  return hexFromBytes(await sha256(snapshotBytes(snapshot)));
}

/**
 * Sort snapshot slots ascending.
 *
 * Deliberately looser than {@link sortedSlots}: a snapshot carries no probabilities, so none of
 * the odds invariants (ppm summing to a million, contiguous indices) apply here. Duplicates ARE
 * rejected though — two entries for one slot leave the preimage dependent on the order they
 * happened to arrive in, which is precisely the property sorting exists to remove. No legitimate
 * snapshot contains one.
 */
function sortedSnapshotSlots(slots: readonly SnapshotSlot[]): SnapshotSlot[] {
  if (slots.length === 0) throw new Error('a snapshot must have at least one slot');

  const sorted = [...slots].sort((a, b) => a.slotIndex - b.slotIndex);
  sorted.forEach((slot, position) => {
    if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 0) {
      throw new Error(`slotIndex must be a non-negative integer, was ${slot.slotIndex}`);
    }
    if (position > 0 && sorted[position - 1].slotIndex === slot.slotIndex) {
      throw new Error(`duplicate slotIndex ${slot.slotIndex} — the snapshot preimage would be ambiguous`);
    }
  });
  return sorted;
}

/**
 * A u32 big-endian BYTE-length prefix followed by the UTF-8 bytes themselves.
 *
 * `TextEncoder` is used rather than `str.length` on purpose, and it is the whole subtlety of this
 * preimage: for `'café'` the byte length is 5 and the code-unit length is 4; for an emoji outside
 * the BMP the string is two code units and four bytes.
 */
function writeUtf8(out: number[], value: string): void {
  const bytes = new TextEncoder().encode(value);
  writeU32(out, bytes.length, 'displayedMedia byte length');
  out.push(...bytes);
}

// ---------------------------------------------------------------------------
// Parsing published data
// ---------------------------------------------------------------------------

/**
 * Build an {@link Edition} from published JSON, turning the cents fields into `BigInt`.
 *
 * They arrive as decimal STRINGS on purpose. `JSON.parse` silently rounds anything beyond
 * `Number.MAX_SAFE_INTEGER`, and it does so before a reviver could intervene, so a bare numeric
 * literal would be unrecoverable by the time this function ran. Numbers are accepted too, but only
 * when they are exactly representable — otherwise the data has already been corrupted upstream and
 * failing loudly beats fingerprinting the rounded value.
 */
export function parseEdition(json: unknown): Edition {
  const raw = json as Record<string, unknown>;
  const slots = raw?.slots;
  if (!Array.isArray(slots)) {
    throw new Error('edition.slots must be an array');
  }
  return {
    engineId: String(raw.engineId),
    engineVersion: Number(raw.engineVersion),
    priceCents: toBigInt(raw.priceCents, 'priceCents'),
    slots: slots.map((slot: Record<string, unknown>) => ({
      slotIndex: Number(slot.slotIndex),
      probabilityPpm: Number(slot.probabilityPpm),
      requiredBuyBackValueCents: toBigInt(slot.requiredBuyBackValueCents, 'requiredBuyBackValueCents'),
      requiredMarketValueCents: toBigInt(slot.requiredMarketValueCents, 'requiredMarketValueCents'),
    })),
  };
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new Error(`${field} must be a decimal integer string, was '${value}'`);
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `${field} arrived as the JSON number ${value}, which is beyond Number.MAX_SAFE_INTEGER and ` +
          'has already lost precision. It must be published as a decimal string.',
      );
    }
    return BigInt(value);
  }
  throw new Error(`${field} must be a decimal string, was ${typeof value}`);
}

/**
 * Build a {@link Snapshot} from the `snapshot.body` JSON that `GET /verify/snapshots/{hash}`
 * serves, accepting either the raw JSON text or an already-parsed object.
 *
 * The body uses `snake_case` and is a *rendering* of the same facts the preimage hashes — the
 * content address is taken over the canonical bytes, never over this JSON. That is deliberate and
 * worth understanding before you write your own parser: it means whitespace, key order or a
 * different JSON library cannot move the hash, and it means a verifier must rebuild the preimage
 * from the parsed fields rather than hashing the bytes it received.
 *
 * **One sharp edge.** `displayed_value_cents` is published as a bare JSON number, not the decimal
 * string the edition's cents fields use. Realistic money is far inside `Number.MAX_SAFE_INTEGER`
 * so this is exact in practice, but a value beyond it would be rounded by `JSON.parse` before any
 * code here could intervene. Rather than fingerprint a rounded value, that case throws — pass the
 * text form and this function re-reads the literal exactly.
 */
export function parseSnapshotBody(body: unknown): Snapshot {
  const exact = typeof body === 'string' ? exactCentsFromText(body) : null;
  const raw = (typeof body === 'string' ? JSON.parse(body) : body) as Record<string, unknown>;

  const version = raw?.format_version;
  if (version !== undefined && Number(version) !== SNAPSHOT_DOMAIN_BYTE) {
    throw new Error(`unsupported snapshot format_version ${version} — this library implements 0x03`);
  }
  const slots = raw?.slots;
  if (!Array.isArray(slots)) throw new Error('snapshot body must carry a slots array');

  return {
    editionFingerprint: String(raw.edition_fingerprint),
    slots: slots.map((slot: Record<string, unknown>, i) => ({
      slotIndex: Number(slot.slot_index),
      currentItemId: String(slot.current_item_id),
      displayedValueCents: toBigInt(exact?.[i] ?? slot.displayed_value_cents, 'displayed_value_cents'),
      displayedMedia: String(slot.displayed_media ?? ''),
    })),
  };
}

/**
 * Recover every `displayed_value_cents` literal from the body TEXT, in document order, before
 * `JSON.parse` can round it.
 *
 * Whitespace around the colon is tolerated because the body reaches you through **two** renderers
 * and they do not agree. The platform writes it with compact separators (`"k":v`), but it is stored
 * as Postgres `jsonb`, which re-renders on the way out with a space after every colon AND its own
 * key order (by key length, then bytewise — not the writer's alphabetical order). The value itself
 * survives that round trip exactly, since `jsonb` holds numbers as `numeric`; it is only
 * `JSON.parse` in the browser that would round it.
 *
 * Order is still safe to rely on: this scans and `JSON.parse` reads the same text, so the nth
 * literal here is the nth slot there whatever order the keys arrived in.
 */
function exactCentsFromText(body: string): string[] | null {
  const matches = [...body.matchAll(/"displayed_value_cents"\s*:\s*(-?\d+)/g)].map((m) => m[1]);
  return matches.length > 0 ? matches : null;
}

/**
 * Build a {@link Snapshot} from the camelCase, decimal-string shape used by the golden-vector
 * fixture (`slotsAsGiven`). Exact for every i64 by construction — see {@link parseSnapshotBody}
 * for the published-body path and why the two differ.
 */
export function parseSnapshot(json: unknown): Snapshot {
  const raw = json as Record<string, unknown>;
  const slots = raw?.slots ?? raw?.slotsAsGiven;
  if (!Array.isArray(slots)) throw new Error('snapshot.slots must be an array');

  return {
    editionFingerprint: String(raw.editionFingerprint),
    slots: slots.map((slot: Record<string, unknown>) => ({
      slotIndex: Number(slot.slotIndex),
      currentItemId: String(slot.currentItemId),
      displayedValueCents: toBigInt(slot.displayedValueCents, 'displayedValueCents'),
      displayedMedia: String(slot.displayedMedia ?? ''),
    })),
  };
}

// ---------------------------------------------------------------------------
// The whole verification
// ---------------------------------------------------------------------------

/**
 * Verify one open end to end, offline.
 *
 * Order matters for how a failure reads, not for the result: the commitment is checked first
 * because a broken commitment means the seed was chosen after the fact and nothing downstream is
 * worth reading; the fingerprint next, because a mismatch there means the odds are unverified and
 * a matching slot proves nothing.
 */
export async function verify(input: VerificationInput): Promise<VerificationReport> {
  const serverSeed = bytesFromHex(input.serverSeedHex);
  requireSeed(serverSeed);

  const computedCommitment = await commitment(serverSeed);
  const derivation = await derive(serverSeed, input.clientSeed, input.nonce);
  const preimage = editionBytes(input.edition);
  const computedFingerprint = hexFromBytes(await sha256(preimage));
  const computedSlotIndex = slotFor(derivation.value, input.edition.slots);

  const checks: VerificationReport['checks'] = {
    commitment: check(input.commitmentHex.toLowerCase(), computedCommitment),
    editionFingerprint: check(input.expected.editionFingerprint.toLowerCase(), computedFingerprint),
    drawnPpmValue: check(String(input.expected.drawnPpmValue), String(derivation.value)),
    drawnSlotIndex: check(String(input.expected.drawnSlotIndex), String(computedSlotIndex)),
  };
  const trace: VerificationReport['trace'] = {
    ...derivation,
    editionPreimageHex: hexFromBytes(preimage),
    computedEditionFingerprint: computedFingerprint,
    computedSlotIndex,
  };
  const caveats: string[] = [];

  if (input.snapshot) {
    const { snapshotHash: expectedHash, itemId: expectedItemId } = input.expected;
    if (expectedHash === undefined || expectedItemId === undefined) {
      throw new Error('expected.snapshotHash and expected.itemId are required when a snapshot is supplied');
    }
    const snapshotPreimage = snapshotBytes(input.snapshot);
    const computedSnapshotHash = hexFromBytes(await sha256(snapshotPreimage));
    // The slot the MATHS selected, never the one we were told — checking the claimed slot's item
    // against the claimed item would be circular.
    const filled = input.snapshot.slots.find((slot) => slot.slotIndex === computedSlotIndex);
    const itemIdInDrawnSlot = filled ? filled.currentItemId.toLowerCase() : NO_SUCH_SLOT;

    checks.snapshotHash = check(expectedHash.toLowerCase(), computedSnapshotHash);
    checks.snapshotEditionLink = check(computedFingerprint, input.snapshot.editionFingerprint.toLowerCase());
    checks.drawnItemId = check(expectedItemId.toLowerCase(), itemIdInDrawnSlot);

    trace.snapshotPreimageHex = hexFromBytes(snapshotPreimage);
    trace.computedSnapshotHash = computedSnapshotHash;
    trace.itemIdInDrawnSlot = itemIdInDrawnSlot;
  } else {
    caveats.push(
      `NOT VERIFIED: which item filled slot ${computedSlotIndex}. This run proves the draw and the ` +
        'odds it ran on, so the position you won is genuine — but no prize-table snapshot was ' +
        'supplied, and nothing here looked at items. A fair draw on fair odds can still be paired ' +
        'with a misreported prize. Supply the published snapshot to close that gap.',
    );
  }

  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([name]) => name);

  return {
    ok: failed.length === 0,
    checks,
    trace,
    caveats,
    summary:
      failed.length === 0
        ? `Verified: nonce ${input.nonce} draws ppm ${derivation.value}, which lands on slot ` +
          `${computedSlotIndex} of an edition whose published odds match its recorded fingerprint` +
          (input.snapshot
            ? `, and the prize table pinned to that edition puts item ${trace.itemIdInDrawnSlot} in it.`
            : '. The item in that slot was NOT verified — see caveats.')
        : `FAILED: ${failed.join(', ')} did not match. This open is not verified.`,
  };
}

/** Stands in for the item id when the drawn slot is absent from the snapshot — a legible FAIL. */
const NO_SUCH_SLOT = '(no such slot in the published snapshot)';

function check(expected: string, computed: string): Check {
  return { ok: expected === computed, expected, computed };
}

// ---------------------------------------------------------------------------
// Input guards — mirroring the certified engine's own preconditions
// ---------------------------------------------------------------------------

function requireSeed(serverSeed: Uint8Array): void {
  if (serverSeed.length !== SERVER_SEED_BYTES) {
    throw new Error(`server seed must be ${SERVER_SEED_BYTES} bytes, was ${serverSeed.length}`);
  }
}

function requireClientSeed(clientSeed: string): void {
  if (!CLIENT_SEED_PATTERN.test(clientSeed)) {
    throw new Error(
      `client seed must match ${CLIENT_SEED_PATTERN} (rng-fairness.md §2), was '${clientSeed}'`,
    );
  }
}

function requireNonce(nonce: number): void {
  if (!Number.isInteger(nonce) || nonce < 1) {
    throw new Error(`nonce is a positive integer starting at 1, was ${nonce}`);
  }
}
