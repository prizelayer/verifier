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
 *  1. **The draw.** SHA-256(server seed) matches the commitment published for its seed pair; then the
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

/**
 * One 4-byte chunk of an HMAC the derivation loop computed, with what the loop did with it.
 *
 * `not-reached` chunks are the ones after the accepted chunk: the loop never looked at them, but they
 * are part of the HMAC a reader sees, so they are listed rather than silently dropped.
 */
export interface ChunkVerdict {
  attempt: number;
  offset: number;
  chunk: number;
  verdict: 'rejected' | 'accepted' | 'not-reached';
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
  /** Every chunk of every attempt, in loop order: eight per attempt, the last attempt included. */
  chunks: ChunkVerdict[];
}

/** Everything needed to verify one open. Assemble it from the published verification data. */
export interface VerificationInput {
  /**
   * The revealed server seed, 64 lowercase hex characters, or `null` while the pair is still active.
   *
   * `null` is an honest state, not an error: the seed is published only when its pair retires. The
   * report is then `pending` — the checks that do not need the seed still run, so the odds can be
   * verified before the draw can.
   */
  serverSeedHex: string | null;
  /**
   * The commitment published for this seed pair. The check is that the revealed seed hashes to it.
   * WHEN it was published is not something this library can see: that is proven by whoever saw
   * the commitment before playing, or by the publisher's own records.
   */
  commitmentHex: string;
  clientSeed: string;
  nonce: number;
  edition: Edition;
  /**
   * The published prize-table snapshot, if you have it.
   *
   * OPTIONAL, and its absence is reported rather than ignored: without it the chain stops at a
   * slot NUMBER. You would have checked that the revealed seed lands on position `i`, under odds
   * that match their fingerprint, and nothing at all about what was in position `i`. When omitted, {@link VerificationReport.caveats}
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
    /**
     * The item id recorded for the win. Optional even with a snapshot: without it the snapshot is
     * still checked, and the item comparison is reported as not run, with a caveat — never as a pass.
     */
    itemId?: string;
    /** On an upgrade win: the id of the step that made it (the staked win's id). */
    upgradeStepId?: string;
    /** On an upgrade win: the slot of the win that was staked for it. Required when `gameKind` is `upgrade`. */
    stakedSlotIndex?: number;
    /** On an upgrade win: the chance of the step that made it, in ppm. Required when `gameKind` is `upgrade`. */
    stepChancePpm?: number;
    /**
     * On an upgrade win: that chance as the player was shown it (contract §7 `stepChanceCompact`). It must be
     * the contract's text of the fair chance. Required when `gameKind` is `upgrade`.
     */
    stepChanceCompact?: string;
    /** On an upgrade win: how that step ended. Required when `gameKind` is `upgrade`. */
    stepOutcome?: 'won' | 'lost';
    /**
     * On an upgrade win made by a version 4 step with an amount: that amount, a decimal string of whole cents
     * from 1 (contract §7 `stepBoostCents`). Absent when none was added; any other shape makes the record unreadable.
     */
    stepBoostCents?: string;
  };
  /**
   * `upgrade` when the win was made by an upgrade step, not by a box draw. Its drawn value, nonce and
   * slot are then the step's: the slot is read over the step's two-entry table, never over the box
   * table. Absent means a box open, checked exactly as before.
   */
  gameKind?: 'box_open' | 'upgrade';
}

/**
 * One claim, checked. `expected` is what we were told; `computed` is what the maths says.
 *
 * When the input a check needs is unusable — a seed of the wrong length, a table whose chances do
 * not add up — the check FAILS with `error` saying why and `field` naming the input. A broken input
 * is a failed claim, not a crash: a page that threw here would show a sceptic nothing at all.
 */
export interface Check {
  ok: boolean;
  expected: string;
  computed: string;
  error?: string;
  field?: string;
}

/** The names of the checks, in the order a reader should meet them. */
export const CHECK_NAMES = [
  'commitment',
  'editionFingerprint',
  'drawnPpmValue',
  'drawnSlotIndex',
  'snapshotHash',
  'snapshotEditionLink',
  'drawnItemId',
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

/**
 * The step of the published walk-through each check belongs to: 1 the commitment, 2 the odds,
 * 3 the draw, 4 from the drawn value to the item.
 */
export const STEP_OF: Readonly<Record<CheckName, 1 | 2 | 3 | 4>> = {
  commitment: 1,
  editionFingerprint: 2,
  drawnPpmValue: 3,
  drawnSlotIndex: 4,
  snapshotHash: 4,
  snapshotEditionLink: 4,
  drawnItemId: 4,
};

/** A check that did not run, and why. Absence from `checks` is never left unexplained. */
export interface NotRun {
  check: CheckName;
  reason: string;
}

/** The first failing check, in step order — what a reader should be shown first. */
export interface Failure {
  check: CheckName;
  step: 1 | 2 | 3 | 4;
  field?: string;
  message: string;
}

/**
 * - `verified`: every check that ran passed, and the commitment, the odds, the draw and the slot all ran.
 * - `failed`: at least one check that ran failed, or an input it needed was unusable. This wins over
 *   `pending`: odds that do not match their fingerprint fail the open whatever the seed turns out to be.
 * - `pending`: the server seed is not revealed yet, and every check that could run passed. The draw
 *   itself cannot be checked yet.
 * - `invalid`: the input could not be read at all. Nothing was checked.
 */
export type VerificationStatus = 'verified' | 'failed' | 'pending' | 'invalid';

/** One range of the cumulative lookup: slot `slotIndex` owns every `v` with `from <= v < to`. */
export interface CumulativeRow {
  slotIndex: number;
  probabilityPpm: number;
  from: number;
  to: number;
}

/** The verdict, with enough detail to see exactly where a failing verification diverged. */
export interface VerificationReport {
  /** True only when {@link status} is `verified`. A single failure invalidates the whole verification. */
  ok: boolean;
  status: VerificationStatus;
  /** Present when `status` is `failed`: the first failing check in step order. */
  firstFailure?: Failure;
  /**
   * Present when `status` is `invalid`. `message` is plain and names the input; `detail` carries
   * the runtime's own error text when the refusal was not one of this library's named ones.
   */
  invalid?: { message: string; detail?: string };
  /** Every check that did not run, with the reason. */
  notRun: NotRun[];
  /** The checks that ran. A check that did not run is absent here and listed in {@link notRun}. */
  checks: {
    /** SHA-256(revealed seed) equals the published commitment. */
    commitment?: Check;
    /** The published odds are the odds that were fingerprinted. Without this the rest is theatre. */
    editionFingerprint?: Check;
    /** The derivation reproduces the recorded ppm value. */
    drawnPpmValue?: Check;
    /** The cumulative lookup reproduces the recorded slot. */
    drawnSlotIndex?: Check;
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
  /** Every intermediate value that could be computed. A value whose inputs were unusable is absent. */
  trace: Partial<Derivation> & {
    /** The canonical `0x01` edition preimage, lowercase hex — the exact bytes that were hashed. */
    editionPreimageHex?: string;
    computedEditionFingerprint?: string;
    /** The cumulative lookup table, one row per slot in ascending `slotIndex` order. */
    cumulative?: CumulativeRow[];
    computedSlotIndex?: number;
    /**
     * An upgraded win only: how the library read v over the step's two ranges. With it, `cumulative` is the
     * step's table (row 0 wins, row 1 loses), never the box's; while the seed is locked neither is set.
     */
    computedStepOutcome?: 'won' | 'lost';
    /** An upgraded win only: the rule set its step was read under, when not the default (`DEMO_RULES_2026_11_17`). */
    ruleSet?: string;
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

/** The commitment of a seed pair: SHA-256 over the raw seed bytes, lowercase hex. */
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
  const chunks: ChunkVerdict[] = [];
  for (let attempt = 0; ; attempt++) {
    const message = drawMessage(clientSeed, nonce, attempt);
    const hmac = await hmacSha256(serverSeed, message);

    for (const offset of CHUNK_OFFSETS) {
      const chunk = bigEndianUint32(hmac, offset);
      if (chunk < ACCEPTANCE_THRESHOLD) {
        chunks.push({ attempt, offset, chunk, verdict: 'accepted' });
        for (const later of CHUNK_OFFSETS.filter((o) => o > offset)) {
          chunks.push({ attempt, offset: later, chunk: bigEndianUint32(hmac, later), verdict: 'not-reached' });
        }
        return {
          value: chunk % PPM_TOTAL,
          attempt,
          offset,
          rejected,
          message: new TextDecoder().decode(message),
          hmacHex: hexFromBytes(hmac),
          acceptedChunk: chunk,
          chunks,
        };
      }
      rejected.push({ attempt, offset, chunk });
      chunks.push({ attempt, offset, chunk, verdict: 'rejected' });
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
 * The cumulative lookup {@link slotFor} walks, as a table a reader can check by hand: slot `i` owns
 * every `v` with `from <= v < to`. A zero-probability slot owns an empty range (`from === to`).
 * Validates the table exactly as {@link slotFor} does.
 */
export function cumulativeTable(slots: readonly Pick<SlotOdds, 'slotIndex' | 'probabilityPpm'>[]): CumulativeRow[] {
  let from = 0;
  return sortedSlots(slots).map((slot) => {
    const row = { slotIndex: slot.slotIndex, probabilityPpm: slot.probabilityPpm, from, to: from + slot.probabilityPpm };
    from = row.to;
    return row;
  });
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
// The upgrade step — rng-fairness §4b
// ---------------------------------------------------------------------------

/**
 * The lowest chance an upgrade step may be offered at, in ppm (10 %). Version 1's minimum, and the minimum
 * of the single offer ({@link upgradeTarget}) on versions 1 and 2.
 */
export const UPGRADE_MIN_CHANCE_PPM = 100_000;

/** The lowest chance a version 2 step may name a target at, in ppm (1 %). */
export const UPGRADE_JUMP_MIN_CHANCE_PPM = 10_000;

/** The lowest chance of a version 3 step, for a named target and the single offer alike, in ppm (0.1 %). */
export const UPGRADE_V3_MIN_CHANCE_PPM = 1_000;

/** The most upgrade steps one box win may climb on versions 1 and 2. Version 3 has no limit of its own. */
export const UPGRADE_MAX_STEPS = 3;

/**
 * The highest step number on a version with no limit of its own: each step goes to a strictly higher value
 * of the same edition, and an edition holds at most 30 prizes, so a chain has at most 29 steps. The platform's
 * database keeps the same ceiling for every version.
 * Refs: ADR-KAN-1154 amendment 8 §8.2
 */
export const UPGRADE_MAX_CHAIN = 29;

/**
 * The caveats this library writes only for a version 3 step or win, approved word for word with the page's
 * other new sentences in the owner's decisions of 2026-11-20 (KAN-1751). The site's table
 * (`site/src/words.ts`, `UPGRADE_V3_WORDS`) lists them too; a change to either is a new decision.
 * Refs: KAN-1751
 */
export const UPGRADE_V3_CAVEATS = Object.freeze({
  stepNo: (maxStepNo: number): string =>
    `The step number is the platform's claim. This version has no limit on steps in a row; this run checks ` +
    `only that the number is in range 1..${maxStepNo}, because a box holds at most 30 prizes and each step ` +
    'goes to a more valuable one. Which earlier steps led to this one is shown on their own pages.',
  win: (stakedSlot: number, drawnSlot: number, stepId: string | undefined): string =>
    `This win was made by an upgrade step from slot ${stakedSlot} on version 3 of the upgrade rules. This run ` +
    `checks that slot ${drawnSlot} is a target the edition allows from slot ${stakedSlot} on that version, that ` +
    "the chance is the box's upgrade rate times the value staked, divided by the value of that slot, rounded " +
    "up to a millionth, and that the step's draw wins at it over the step's own table. Which target the step named is not " +
    `compared here: it is shown on the step's own page${stepId === undefined ? '' : ` (step ${stepId})`}, and so ` +
    `are that the staked win really held slot ${stakedSlot}, the step number and the engine type, which this ` +
    'run does not check.',
});

/**
 * An amount in cents as the caveats write a value: euros with two decimals and a comma every three digits,
 * no currency sign (2128 is "21.28", 100000 is "1,000.00").
 */
function centsText(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/**
 * The caveats this library writes only for a version 4 step or win. DRAFTS: the words are the player
 * owner's, and they are public only once approved with the merge (KAN-1569 plan v1.1 §3.3, sentences 24 and
 * 25; the go's SHOULD 1: an amount is "recorded", because the check reads the record, never a wallet). The
 * step number reads as on version 3, because version 4 has no limit on steps of its own either.
 * Refs: KAN-1569
 */
export const UPGRADE_V4_CAVEATS = Object.freeze({
  stepNo: UPGRADE_V3_CAVEATS.stepNo,
  win: (stakedSlot: number, drawnSlot: number, stepId: string | undefined, boostCents: bigint | undefined): string =>
    `This win was made by an upgrade step from slot ${stakedSlot} on version 4 of the upgrade rules` +
    `${boostCents === undefined ? '' : `, with an amount of ${centsText(boostCents)} recorded`}. This run checks ` +
    `that slot ${drawnSlot} is a target the edition allows from slot ${stakedSlot} on that version, that the ` +
    "chance is the box's upgrade rate times the sum of the value staked and the amount recorded, divided by the " +
    'value of that slot, rounded up to a millionth, that the amount is within the limits of the upgrade rules, ' +
    "and that the step's draw wins at it over the step's own table. Which target the step named is not compared " +
    `here: it is shown on the step's own page${stepId === undefined ? '' : ` (step ${stepId})`}, and so are that ` +
    `the staked win really held slot ${stakedSlot}, the step number and the engine type, which this run does not ` +
    'check.',
});

/** The caveats of one version: on the step number of a step, and on the step that made an upgraded win. */
export interface UpgradeVersionCaveats {
  stepNo(maxStepNo: number): string;
  win(stakedSlot: number, drawnSlot: number, stepId: string | undefined, boostCents: bigint | undefined): string;
}

/** The step-number caveat of versions 1 and 2, whose limit on steps is the cap. */
function capStepNoCaveat(maxStepNo: number): string {
  return (
    `The step number is the platform's claim. This run checks only that it is in range 1..${maxStepNo} ` +
    '(the cap); which earlier steps led to this one is shown on their own pages.'
  );
}

/** Version 1's win caveat, also the one a win on a version this library does not check gets. */
function nextUpWinCaveat(stakedSlot: number, _drawnSlot: number, stepId: string | undefined): string {
  return (
    `This win was made by an upgrade step from slot ${stakedSlot}. This run checks the step's draw, its ` +
    'fair chance and its target over the step\'s own table. That the staked win really held slot ' +
    `${stakedSlot} is shown on the step's own page` +
    `${stepId === undefined ? '' : ` (step ${stepId})`}, ` +
    'and so are the cap on steps and the engine type and version, which this run does not check.'
  );
}

/**
 * The caveats of each version this library checks, one entry per version of {@link UPGRADE_RULES}, so a
 * version can never be worded with another version's text (a test holds that every rule has its entry). A
 * win on a version not listed keeps version 1's general words, which claim nothing about a version.
 * Refs: KAN-1569 plan v1.1 L8
 */
export const UPGRADE_CAVEATS_BY_VERSION: Readonly<Record<number, UpgradeVersionCaveats>> = Object.freeze({
  1: Object.freeze({ stepNo: capStepNoCaveat, win: nextUpWinCaveat }),
  2: Object.freeze({
    stepNo: capStepNoCaveat,
    win: (stakedSlot: number, drawnSlot: number, stepId: string | undefined): string =>
      `This win was made by an upgrade step from slot ${stakedSlot} on version 2 of the ` +
      `upgrade rules. This run checks that slot ${drawnSlot} is a target the edition ` +
      `allows from slot ${stakedSlot} on that version, that the chance is the formula's, and that the step's ` +
      'draw wins at it over the step\'s own table. Which target the step named is not compared here: it is ' +
      'shown on the step\'s own page' +
      `${stepId === undefined ? '' : ` (step ${stepId})`}, ` +
      `and so are that the staked win really held slot ${stakedSlot}, the cap on steps and the engine type, ` +
      'which this run does not check.',
  }),
  3: Object.freeze({
    stepNo: UPGRADE_V3_CAVEATS.stepNo,
    win: (stakedSlot: number, drawnSlot: number, stepId: string | undefined): string => UPGRADE_V3_CAVEATS.win(stakedSlot, drawnSlot, stepId),
  }),
  4: UPGRADE_V4_CAVEATS,
});

/**
 * The most a version 4 step may record as the amount added to the value staked, in cents (1,000.00). A
 * casino may set a lower limit; the step's record does not carry it, so a check here holds only this one.
 * Refs: KAN-1569, ADR-KAN-1154 amendment 9 §9.3
 */
export const UPGRADE_BOOST_CEILING_CENTS = 100_000;

/**
 * The highest chance a version 4 step may reach with an amount, in ppm (50 %). It binds only an amount: a
 * step with no amount is a version 3 step, and its chance may be higher.
 * Refs: KAN-1569, ADR-KAN-1154 amendment 9 §9.3
 */
export const UPGRADE_BOOST_MAX_CHANCE_PPM = 500_000;

/** The highest rate of a version 3 step, in basis points (99.90 %): a step never gives the player the edge. */
export const UPGRADE_STEP_RTP_CAP_BPS = 9_990;

/**
 * The lowest rate of a version 3 step, in basis points (93 %): the platform's floor on a box's return. No
 * edition below it can be published, so a step on one fails here rather than being checked at a made-up rate.
 */
export const UPGRADE_STEP_RTP_FLOOR_BPS = 9_300;

/** The slot an upgrade step is offered for, and its chance. */
export interface UpgradeOffer {
  targetSlotIndex: number;
  chancePpm: number;
}

/**
 * One version of the upgrade engine. `minChancePpm` is the lowest chance of a named target and
 * `offerMinChancePpm` that of the single offer; `jumps` says whether a step may name any higher value of the
 * box or only the next one up; `maxSteps` is the limit on steps in a row, or `null` for none. The step's
 * return is `stepRtpBps` when the version fixes it, and otherwise the box's own rate, between
 * `stepRtpFloorBps` and `stepRtpCapBps` ({@link upgradeStepRateBps}). `roundsUp` says which way the chance
 * is rounded to a whole ppm. A version on which a step may record an amount added to the value staked has
 * the engine's two limits on it: `boostCeilingCents` and `boostMaxChancePpm` ({@link boostStepLimits}).
 */
export interface UpgradeRule {
  engineVersion: number;
  minChancePpm: number;
  offerMinChancePpm: number;
  jumps: boolean;
  maxSteps: number | null;
  stepRtpBps: number | null;
  stepRtpCapBps: number | null;
  stepRtpFloorBps: number | null;
  roundsUp: boolean;
  boostCeilingCents?: number;
  boostMaxChancePpm?: number;
}

/**
 * Every version of the upgrade engine this library checks, each with its own rule. A step on a version not
 * listed here is failed, never checked by another version's rule (rng-fairness §6: version for version, fail
 * closed). Version 2 lets a step name any strictly higher value at 1 % or more. Version 3 has no limit on
 * steps, a minimum of 0.1 % for a named target and the single offer, and a chance at the rate of the step's
 * own box, rounded up, so every step gives back at least that rate. Version 4 is version 3 plus an amount
 * the step may record, added to the value staked, within the two limits of the engine.
 * Refs: KAN-1567, KAN-1751, KAN-1569, ADR-KAN-1154 amendments 4, 8 and 9
 */
export const UPGRADE_RULES: readonly UpgradeRule[] = Object.freeze([
  Object.freeze({
    engineVersion: 1,
    minChancePpm: UPGRADE_MIN_CHANCE_PPM,
    offerMinChancePpm: UPGRADE_MIN_CHANCE_PPM,
    jumps: false,
    maxSteps: UPGRADE_MAX_STEPS,
    stepRtpBps: 10_000,
    stepRtpCapBps: null,
    stepRtpFloorBps: null,
    roundsUp: false,
  }),
  Object.freeze({
    engineVersion: 2,
    minChancePpm: UPGRADE_JUMP_MIN_CHANCE_PPM,
    offerMinChancePpm: UPGRADE_MIN_CHANCE_PPM,
    jumps: true,
    maxSteps: UPGRADE_MAX_STEPS,
    stepRtpBps: 10_000,
    stepRtpCapBps: null,
    stepRtpFloorBps: null,
    roundsUp: false,
  }),
  Object.freeze({
    engineVersion: 3,
    minChancePpm: UPGRADE_V3_MIN_CHANCE_PPM,
    offerMinChancePpm: UPGRADE_V3_MIN_CHANCE_PPM,
    jumps: true,
    maxSteps: null,
    stepRtpBps: null,
    stepRtpCapBps: UPGRADE_STEP_RTP_CAP_BPS,
    stepRtpFloorBps: UPGRADE_STEP_RTP_FLOOR_BPS,
    roundsUp: true,
  }),
  Object.freeze({
    engineVersion: 4,
    minChancePpm: UPGRADE_V3_MIN_CHANCE_PPM,
    offerMinChancePpm: UPGRADE_V3_MIN_CHANCE_PPM,
    jumps: true,
    maxSteps: null,
    stepRtpBps: null,
    stepRtpCapBps: UPGRADE_STEP_RTP_CAP_BPS,
    stepRtpFloorBps: UPGRADE_STEP_RTP_FLOOR_BPS,
    roundsUp: true,
    boostCeilingCents: UPGRADE_BOOST_CEILING_CENTS,
    boostMaxChancePpm: UPGRADE_BOOST_MAX_CHANCE_PPM,
  }),
]);

/** The rule of one engine version, or `undefined` for a version this library does not check. */
export function upgradeRule(engineVersion: number): UpgradeRule | undefined {
  return UPGRADE_RULES.find((rule) => rule.engineVersion === engineVersion);
}

/**
 * The rules of the demo on dev that started on 17 November 2026 (KAN-1685): versions 1 and 2, each with its own
 * targets and minimums, at a step return of 9 300. On 17 and 18 November 2026 dev drew some version 1 and 2
 * steps at 93 %; the platform was then reverted to the fair rule, and those steps stay in dev's records until
 * its next reset. The name keeps the day the rule started.
 *
 * A dated, dev-only exception to "version for version, fail closed" (KAN-1751 plan v1.2 D3 A, ADR-KAN-1154
 * amendment 7): the default path never selects it, and {@link verifyUpgradeStep} takes it only as this exact
 * object, so no caller can check a step under a rule of its own making. Only the page's dev build passes it,
 * and only for a step on its list. The report names it. It is deleted with the list at dev's next reset.
 * Refs: KAN-1751, KAN-1685
 */
export const DEMO_RULES_2026_11_17 = Object.freeze({
  name: 'DEMO_RULES_2026_11_17',
  rules: Object.freeze(
    UPGRADE_RULES.filter((rule) => rule.engineVersion <= 2).map((rule) => Object.freeze({ ...rule, stepRtpBps: 9_300 })),
  ) as readonly UpgradeRule[],
});

/**
 * What {@link verifyUpgradeStep}, and {@link verify} for an upgraded win, take besides the record: on dev only,
 * the demo rule set of 17 and 18 November 2026.
 */
export interface UpgradeStepOptions {
  readonly demoRules?: typeof DEMO_RULES_2026_11_17;
}

/** The rules a check reads: the default table, or the demo set when given as the library's own object. */
function ruleSetOf(options: UpgradeStepOptions): readonly UpgradeRule[] {
  const demo = options.demoRules;
  if (demo !== undefined && demo !== DEMO_RULES_2026_11_17) {
    throw new Error('the only other rule set this library checks a step under is its own DEMO_RULES_2026_11_17');
  }
  return demo?.rules ?? UPGRADE_RULES;
}

const DEMO_CAVEAT =
  'Checked under the demo rules of 17 and 18 November 2026 (a step at 93 %), not the default rule of its ' +
  'version: this step is on the dev list of steps drawn on those two days.';

function requireRule(engineVersion: number): UpgradeRule {
  const rule = upgradeRule(engineVersion);
  if (rule === undefined) throw new Error(`version ${engineVersion} of the upgrade engine is not one this library checks`);
  return rule;
}

/** The odds a step's chance is read from: the slots, and the price when the version's rate is the box's own. */
export type UpgradeEditionOdds = Pick<Edition, 'slots'> & { priceCents?: bigint };

/**
 * The step's return in basis points on `engineVersion`: 10 000 on versions 1 and 2 (a fair step). On version
 * 3 it is the box's own rate, computed here from the edition and never taken from anywhere else:
 * `boxBps = (10 000 · S) div (1 000 000 · P)`, with S the sum over every slot of its chance in ppm times its
 * buy-back cents and P the price in cents, so the box's exact return rounded DOWN to a whole basis point;
 * then `min(boxBps, 9 990)`, taken on the exact integer. An edition whose rate would be under 9 300, or whose
 * price is not positive, is refused: no such box can be published.
 *
 * The worked box of ADR-KAN-1154 §8.3 (20,00; 5, 12, 20, 45 and 200 at 444 750, 300 000, 140 000, 80 000
 * and 35 250 ppm) returns 96.36875 % and gives 9 636.
 * Refs: KAN-1751, ADR-KAN-1154 amendment 8 §8.3
 */
export function upgradeStepRateBps(edition: UpgradeEditionOdds, engineVersion: number): number {
  return stepRate(edition, requireRule(engineVersion));
}

function stepRate(edition: UpgradeEditionOdds, rule: UpgradeRule): number {
  if (rule.stepRtpBps !== null) return rule.stepRtpBps;
  const floor = rule.stepRtpFloorBps as number;
  const cap = rule.stepRtpCapBps as number;
  const price = edition.priceCents;
  if (typeof price !== 'bigint' || price <= 0n) {
    throw new Error(`version ${rule.engineVersion} reads the box's rate from its price, which must be above 0 cents, was ${String(price)}`);
  }
  let sum = 0n;
  for (const slot of sortedSlots(edition.slots)) sum += BigInt(slot.probabilityPpm) * slot.requiredBuyBackValueCents;
  const boxBps = (10_000n * sum) / (BigInt(PPM_TOTAL) * price);
  if (boxBps < BigInt(floor)) {
    throw new Error(
      `the box returns ${boxBps} bps, under the ${floor} bps floor of version ${rule.engineVersion}: no such box can be published`,
    );
  }
  return Number(boxBps < BigInt(cap) ? boxBps : BigInt(cap));
}

/**
 * The chance of a step from a held value to a higher one at a step return of `rateBps`: `RTP × 1 000 000 ×
 * current / next` ppm with RTP = `rateBps` / 10 000, rounded down, or up when `roundsUp`. The defaults are
 * the fair step of versions 1 and 2, `floor(1 000 000 × current / next)`, so its expected value never
 * exceeds the value staked: 12,00 → 30,00 gives 400 000. Version 3 rounds up at its box's rate
 * ({@link upgradeStepRateBps}), so its step gives back at least that rate: 20,00 → 45,00 at 9 636 gives
 * 428 267 (428 266.67).
 *
 * Exact in `bigint`: no float ever touches a chance.
 * Refs: KAN-1751, ADR-KAN-1154 amendment 8 §8.4
 */
export function upgradeChancePpm(
  currentCents: bigint,
  nextCents: bigint,
  rateBps: number = UPGRADE_STEP_RTP_BPS,
  roundsUp = false,
): number {
  if (currentCents <= 0n || nextCents <= currentCents) {
    throw new Error(`a step needs 0 < current < next, was ${currentCents} → ${nextCents}`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 1 || rateBps > 10_000) {
    throw new Error(`a step return is an integer in [1, 10000] bps, was ${rateBps}`);
  }
  const numerator = BigInt(rateBps) * BigInt(PPM_TOTAL) * currentCents;
  const denominator = 10_000n * nextCents;
  return Number(roundsUp ? (numerator + denominator - 1n) / denominator : numerator / denominator);
}

/**
 * The single offer a win in `slotIndex` gets on `engineVersion` (version 1 when not given), or `null`: the
 * next strictly higher buy-back value of the same edition, ties broken by the lowest slot index. Never the
 * next slot INDEX, because slot order is the draw's order, not the value's. No offer from the top value, and
 * none when the next value gives a chance under the version's single-offer minimum (10 % on versions 1 and 2,
 * 0.1 % on version 3), even if a value further up would pass, and none from a held value of 0.
 *
 * The limit on steps is not checked here: it depends on how the win was made, not on the edition.
 */
export function upgradeTarget(edition: UpgradeEditionOdds, slotIndex: number, engineVersion = UPGRADE_ENGINE_VERSION): UpgradeOffer | null {
  return offerFor(edition, slotIndex, requireRule(engineVersion));
}

/** {@link upgradeTarget} under a rule already chosen, so a step is never checked against a second lookup. */
function offerFor(edition: UpgradeEditionOdds, slotIndex: number, rule: UpgradeRule): UpgradeOffer | null {
  const slots = sortedSlots(edition.slots);
  const held = slots.find((slot) => slot.slotIndex === slotIndex);
  if (held === undefined) throw new Error(`slot ${slotIndex} is not in the edition`);
  const rate = stepRate(edition, rule);
  const current = held.requiredBuyBackValueCents;
  // A held value of 0 has a chance of 0 at any step, which is under the minimum: no offer, as on platform.
  if (current <= 0n) return null;

  let target: SlotOdds | undefined;
  for (const slot of slots) {
    if (slot.requiredBuyBackValueCents <= current) continue;
    if (target === undefined || slot.requiredBuyBackValueCents < target.requiredBuyBackValueCents) target = slot;
  }
  if (target === undefined) return null;

  const chancePpm = upgradeChancePpm(current, target.requiredBuyBackValueCents, rate, rule.roundsUp);
  return chancePpm < rule.offerMinChancePpm ? null : { targetSlotIndex: target.slotIndex, chancePpm };
}

/**
 * Every target a win in `slotIndex` may name on `engineVersion`. On versions 2 and 3: each slot whose buy-back
 * value is strictly higher than the held one, ordered by value, then by slot index, up to the first whose
 * chance is under the version's minimum. The chance never rises as the value rises, so no slot past that one
 * could pass. On version 1 the list is the offer of {@link upgradeTarget} alone. A held value of 0 lists
 * nothing.
 *
 * Throws for a version this library does not check, for a slot the edition does not hold, and on version 3
 * for an edition whose rate cannot be read ({@link upgradeStepRateBps}). The limit on steps is not checked
 * here, as in {@link upgradeTarget}.
 * Refs: KAN-1567, KAN-1751
 */
export function upgradeTargets(edition: UpgradeEditionOdds, slotIndex: number, engineVersion: number): UpgradeOffer[] {
  return targetsFor(edition, slotIndex, requireRule(engineVersion));
}

/** {@link upgradeTargets} under a rule already chosen. */
function targetsFor(edition: UpgradeEditionOdds, slotIndex: number, rule: UpgradeRule): UpgradeOffer[] {
  if (!rule.jumps) {
    const offer = offerFor(edition, slotIndex, rule);
    return offer === null ? [] : [offer];
  }
  const slots = sortedSlots(edition.slots);
  const held = slots.find((slot) => slot.slotIndex === slotIndex);
  if (held === undefined) throw new Error(`slot ${slotIndex} is not in the edition`);
  const rate = stepRate(edition, rule);
  const current = held.requiredBuyBackValueCents;
  if (current <= 0n) return [];

  const higher = slots
    .filter((slot) => slot.requiredBuyBackValueCents > current)
    .sort((a, b) =>
      a.requiredBuyBackValueCents === b.requiredBuyBackValueCents
        ? a.slotIndex - b.slotIndex
        : a.requiredBuyBackValueCents < b.requiredBuyBackValueCents
          ? -1
          : 1,
    );
  const targets: UpgradeOffer[] = [];
  for (const slot of higher) {
    const chancePpm = upgradeChancePpm(current, slot.requiredBuyBackValueCents, rate, rule.roundsUp);
    if (chancePpm < rule.minChancePpm) break;
    targets.push({ targetSlotIndex: slot.slotIndex, chancePpm });
  }
  return targets;
}

/**
 * The step from `stakedSlot` that a record naming `targetSlot` is checked against, under `rule`, or `null`
 * when there is none. Version 1: the offer, whatever slot the record names, so a record naming another
 * slot fails on the target. Versions 2 and 3: the entry of {@link upgradeTargets} for the named slot, so a
 * slot of the box worth more, at the version's minimum or above.
 */
function stepFor(edition: UpgradeEditionOdds, rule: UpgradeRule, stakedSlot: number, targetSlot: number): UpgradeOffer | null {
  if (!rule.jumps) return offerFor(edition, stakedSlot, rule);
  return targetsFor(edition, stakedSlot, rule).find((t) => t.targetSlotIndex === targetSlot) ?? null;
}

/** Why a step has no fair chance, in the words the reports use: version 1 names the staked slot alone. */
function noStepWhy(rule: UpgradeRule, stakedSlot: number, targetSlot: number): string {
  return rule.jumps ? `slot ${stakedSlot} cannot step to slot ${targetSlot}` : `slot ${stakedSlot} is offered no step`;
}

/** The words of a version this library does not check, for the reports. */
function unknownVersionWhy(engineVersion: unknown): string {
  return `version ${String(engineVersion)} of the upgrade rules is not checked here`;
}

// ---------------------------------------------------------------------------
// The amount of a version 4 step — rng-fairness §4b, ADR-KAN-1154 amendment 9
// ---------------------------------------------------------------------------

/**
 * One step an amount may be added to: the edition's engine version, the step's rate (the box's own, from
 * {@link upgradeStepRateBps}), and the buy-back values staked and named, in cents. The platform's
 * `BoostStep` holds the same four facts.
 */
export interface BoostStep {
  engineVersion: number;
  rateBps: number;
  stakedCents: bigint;
  targetCents: bigint;
}

/**
 * A casino's own two limits on an amount. The engine's two limits always apply as well and the lower of
 * each pair wins, so a casino can only lower them. Absent means the engine's limits alone.
 */
export interface BoostLimits {
  maxCents: bigint;
  maxChancePpm: number;
}

/** Why an amount is refused, in the words of the platform's answer. */
export type BoostRefusal = 'boost_too_high' | 'boost_cent_lost';

/** The answer for one amount: accepted at a chance, or refused with the highest amount the step accepts. */
export type BoostDecision =
  | { decision: 'accepted'; boostCents: bigint; chancePpm: number }
  | { decision: 'refused'; refusal: BoostRefusal; boostMaxCents: bigint };

/** A key a step serves: its points, its price in cents and the chance at that price. */
export interface BoostKey {
  points: number;
  boostCents: bigint;
  chancePpm: number;
}

/** One percentage point of chance, the unit of a key: +10 is +100 000 ppm, never 10 % of anything. */
const PPM_PER_POINT = 10_000;

/** The rule of a version on which a step may record an amount, or a refusal naming the version. */
function boostRuleOf(engineVersion: number): UpgradeRule & { boostCeilingCents: number; boostMaxChancePpm: number } {
  const rule = requireRule(engineVersion);
  if (rule.boostCeilingCents === undefined || rule.boostMaxChancePpm === undefined) {
    throw new Error(`version ${engineVersion} of the upgrade rules has no amount to add`);
  }
  return rule as UpgradeRule & { boostCeilingCents: number; boostMaxChancePpm: number };
}

/**
 * The chance of `step` with `boostCents` added, in ppm: version 3's chance from the value staked plus the
 * amount, `ceil(R × 1 000 000 × (s + b) / (10 000 × t))`, so with 0 cents it is the step's chance with no
 * amount. Exact in `bigint`. An amount that reaches the target's value has no chance to compute, and is
 * refused by name.
 *
 * Box C of ADR-KAN-1154 §9.8: R 9 400, 40.00 staked for 200.00, 21.28 added gives 288 016 (and 0 cents
 * gives 188 000).
 * Refs: KAN-1569, ADR-KAN-1154 amendment 9 §9.2
 */
export function boostChancePpm(step: BoostStep, boostCents: bigint): number {
  const rule = boostRuleOf(step.engineVersion);
  if (typeof boostCents !== 'bigint' || boostCents < 0n) {
    throw new Error(`an amount is a whole number of cents, 0 or more, was ${String(boostCents)}`);
  }
  if (step.stakedCents + boostCents >= step.targetCents) {
    throw new Error(
      `${boostCents} cents reach the target's value: ${step.stakedCents} + ${boostCents} >= ${step.targetCents} cents, ` +
        'so the step has no chance to compute',
    );
  }
  return upgradeChancePpm(step.stakedCents + boostCents, step.targetCents, step.rateBps, rule.roundsUp);
}

function moneyCapOf(rule: { boostCeilingCents: number }, limits: BoostLimits | undefined): bigint {
  const engine = BigInt(rule.boostCeilingCents);
  return limits === undefined || limits.maxCents >= engine ? engine : limits.maxCents;
}

function chanceCapOf(rule: { boostMaxChancePpm: number }, limits: BoostLimits | undefined): number {
  return limits === undefined ? rule.boostMaxChancePpm : Math.min(rule.boostMaxChancePpm, limits.maxChancePpm);
}

function requireLimits(limits: BoostLimits | undefined): void {
  if (limits === undefined) return;
  if (typeof limits.maxCents !== 'bigint' || limits.maxCents < 0n) {
    throw new Error(`a casino's money limit is a whole number of cents, 0 or more, was ${String(limits.maxCents)}`);
  }
  if (!Number.isInteger(limits.maxChancePpm) || limits.maxChancePpm < 0) {
    throw new Error(`a casino's chance limit is a whole number of ppm, 0 or more, was ${limits.maxChancePpm}`);
  }
}

/** The money limit, and one cent below the target's value: the chance of anything more is not computed. */
function highestComputable(step: BoostStep, rule: { boostCeilingCents: number }, limits: BoostLimits | undefined): bigint {
  const belowTarget = step.targetCents - step.stakedCents - 1n;
  const money = moneyCapOf(rule, limits);
  return money < belowTarget ? money : belowTarget;
}

/** The largest amount in 0..`highest` whose chance is at most `cap`, or null when 0 is already above it. */
function mostWithin(step: BoostStep, cap: number, highest: bigint): bigint | null {
  if (boostChancePpm(step, 0n) > cap) return null;
  let low = 0n;
  let high = highest;
  while (low < high) {
    const middle = low + (high - low + 1n) / 2n;
    if (boostChancePpm(step, middle) <= cap) low = middle;
    else high = middle - 1n;
  }
  return low;
}

/** The least amount in `from`..`highest` whose chance is at least `chance`, or null when none reaches it. */
function leastReaching(step: BoostStep, chance: number, from: bigint, highest: bigint): bigint | null {
  if (boostChancePpm(step, highest) < chance) return null;
  let low = from;
  let high = highest;
  while (low < high) {
    const middle = low + (high - low) / 2n;
    if (boostChancePpm(step, middle) >= chance) high = middle;
    else low = middle + 1n;
  }
  return low;
}

/**
 * The highest amount `step` accepts, or 0 when it accepts none: at most the engine's and the casino's money
 * limits and one cent under the target's value, a chance of at most the engine's and the casino's chance
 * limits, and, of the amounts with that chance, the least, so its last cent raises the chance. 0 when the
 * chance with no amount is under the version's minimum: money never adds a target. Found by searching
 * {@link boostChancePpm}, as the platform does, never by a second formula; the chance never falls as the
 * amount grows.
 * Refs: KAN-1569, ADR-KAN-1154 amendment 9 §9.3
 */
export function boostMaxCents(step: BoostStep, limits?: BoostLimits): bigint {
  const rule = boostRuleOf(step.engineVersion);
  requireLimits(limits);
  if (boostChancePpm(step, 0n) < rule.minChancePpm) return 0n;
  const highest = highestComputable(step, rule, limits);
  if (highest < 1n) return 0n;
  const top = mostWithin(step, chanceCapOf(rule, limits), highest);
  if (top === null) return 0n;
  return leastReaching(step, boostChancePpm(step, top), 0n, top) as bigint;
}

/**
 * The answer for an amount of `boostCents`, from 1 cent, in the order the platform decides it: above
 * {@link boostMaxCents} it is `boost_too_high`, before its chance is computed; then `boost_cent_lost` when
 * its last cent leaves the chance where it was; else accepted at its chance.
 * Refs: KAN-1569, ADR-KAN-1154 amendment 9 §9.3
 */
export function boostDecision(step: BoostStep, boostCents: bigint, limits?: BoostLimits): BoostDecision {
  if (typeof boostCents !== 'bigint' || boostCents < 1n) {
    throw new Error(`an amount to decide on is at least 1 cent, was ${String(boostCents)}`);
  }
  const rule = boostRuleOf(step.engineVersion);
  const max = boostMaxCents(step, limits);
  if (boostCents > max) return { decision: 'refused', refusal: 'boost_too_high', boostMaxCents: max };
  const chancePpm = boostChancePpm(step, boostCents);
  if (chancePpm <= boostChancePpm(step, boostCents - 1n)) {
    return { decision: 'refused', refusal: 'boost_cent_lost', boostMaxCents: max };
  }
  // The limits that only rise with the amount hold at max, so they hold here; checked again because an
  // accepted amount past a limit is the one answer this function must never give.
  if (boostCents > moneyCapOf(rule, limits) || chancePpm > chanceCapOf(rule, limits)) {
    throw new Error(`${boostCents} cents pass a limit: the search and the limits disagree`);
  }
  return { decision: 'accepted', boostCents, chancePpm };
}

/**
 * The key of `points` percentage points on `step`: its price is the least amount whose chance reaches the
 * chance with no amount plus `points` × 10 000 ppm, or null when that price is not accepted. A key is hidden,
 * never cut down to a limit.
 * Refs: KAN-1569, ADR-KAN-1154 amendment 9 §9.4
 */
export function boostKeyFor(step: BoostStep, points: number, limits?: BoostLimits): BoostKey | null {
  if (!Number.isInteger(points) || points < 1) throw new Error(`a key adds at least 1 point, was ${points}`);
  const rule = boostRuleOf(step.engineVersion);
  requireLimits(limits);
  const highest = highestComputable(step, rule, limits);
  if (highest < 1n) return null;
  const wanted = boostChancePpm(step, 0n) + points * PPM_PER_POINT;
  const price = leastReaching(step, wanted, 1n, highest);
  if (price === null) return null;
  const decided = boostDecision(step, price, limits);
  return decided.decision === 'accepted' ? { points, boostCents: decided.boostCents, chancePpm: decided.chancePpm } : null;
}

/** The keys of a casino's `points` that `step` serves, lowest first, each point counted once. */
export function boostKeys(step: BoostStep, points: readonly number[], limits?: BoostLimits): BoostKey[] {
  return [...new Set(points)]
    .sort((a, b) => a - b)
    .map((p) => boostKeyFor(step, p, limits))
    .filter((key): key is BoostKey => key !== null);
}

/** The engine limit a recorded amount breaks, with the numbers the reports name. */
export type BoostLimitFailure =
  | { limit: 'reachesTarget' }
  | { limit: 'ceiling'; chancePpm: number; ceilingCents: number }
  | { limit: 'cap'; chancePpm: number; capPpm: number }
  | { limit: 'lastCent'; chancePpm: number };

/** {@link boostStepLimits}: the chance of the amount when every limit holds, or the first limit it breaks. */
export type BoostLimitResult = { ok: true; chancePpm: number } | ({ ok: false } & BoostLimitFailure);

/**
 * The engine's limits on an amount a step RECORDS, in the order a reader meets them (plan v1.1 §2.2): the
 * value staked plus the amount stays under the target's value; the amount is at most the ceiling; its chance
 * is at most the cap; and its last cent raised the chance (only `b` against `b − 1`). With no amount (0) only
 * the first applies, and it holds for every target. The minimum is not here: it is read on the chance with no
 * amount, by the target check that runs first ({@link upgradeTargets} at the version's minimum), so one line
 * holds it (the go's SHOULD 3). The casino's own limits are not part of the record, so they are not checked.
 *
 * Used by the step check and by the check of an upgraded win alike, so the two cannot disagree on a limit.
 * Refs: KAN-1569 plan v1.1 L10, ADR-KAN-1154 amendment 9 §9.8
 */
export function boostStepLimits(step: BoostStep, boostCents: bigint): BoostLimitResult {
  const rule = boostRuleOf(step.engineVersion);
  if (typeof boostCents !== 'bigint' || boostCents < 0n) {
    throw new Error(`a recorded amount is a whole number of cents, 0 or more, was ${String(boostCents)}`);
  }
  if (step.stakedCents + boostCents >= step.targetCents) return { ok: false, limit: 'reachesTarget' };
  const chancePpm = boostChancePpm(step, boostCents);
  if (boostCents === 0n) return { ok: true, chancePpm };
  if (boostCents > BigInt(rule.boostCeilingCents)) return { ok: false, limit: 'ceiling', chancePpm, ceilingCents: rule.boostCeilingCents };
  if (chancePpm > rule.boostMaxChancePpm) return { ok: false, limit: 'cap', chancePpm, capPpm: rule.boostMaxChancePpm };
  if (chancePpm <= boostChancePpm(step, boostCents - 1n)) return { ok: false, limit: 'lastCent', chancePpm };
  return { ok: true, chancePpm };
}

/**
 * A broken limit in the words the reports use. The page reads them (site `words.ts`), so each form is fixed:
 * `the value staked plus <b> cents reaches the target's value`, `<b> cents is above the ceiling of <c> cents`,
 * `<b> cents gives a chance of <p> ppm, above the cap of <c> ppm`, `the last cent of <b> cents raises nothing:
 * <b − 1> cents give <p> ppm too`.
 */
function boostLimitWhy(failure: BoostLimitFailure, boostCents: bigint): string {
  switch (failure.limit) {
    case 'reachesTarget':
      return `the value staked plus ${boostCents} cents reaches the target's value`;
    case 'ceiling':
      return `${boostCents} cents is above the ceiling of ${failure.ceilingCents} cents`;
    case 'cap':
      return `${boostCents} cents gives a chance of ${failure.chancePpm} ppm, above the cap of ${failure.capPpm} ppm`;
    case 'lastCent':
      return `the last cent of ${boostCents} cents raises nothing: ${boostCents - 1n} cents give ${failure.chancePpm} ppm too`;
  }
}

/** The step a recorded amount is added to, from the edition: the staked and named slots' values, at `rateBps`. */
function boostStepOf(edition: UpgradeEditionOdds, rule: UpgradeRule, rateBps: number, stakedSlot: number, targetSlot: number): BoostStep {
  const valueOf = (slotIndex: number): bigint => {
    const slot = edition.slots.find((s) => s.slotIndex === slotIndex);
    if (slot === undefined) throw new Error(`slot ${slotIndex} is not in the edition`);
    return slot.requiredBuyBackValueCents;
  };
  return { engineVersion: rule.engineVersion, rateBps, stakedCents: valueOf(stakedSlot), targetCents: valueOf(targetSlot) };
}

/**
 * The wire rule of a recorded amount (cto ruling KAN-1569 37069, which corrects 37014): on the public check every
 * EUR amount in cents is a decimal string, so this one is too: whole cents from 1, written as `String(cents)`
 * writes them, absent when no amount was added. It is read by the parser of `priceCents`; a JSON number, "0", a
 * sign, a leading zero, a fraction or an empty text makes the record unreadable (`invalid`): it is never read as
 * "no amount". Shared by the step and the open record, so both fields are held by the same check.
 */
export function recordedAmountCents(value: unknown, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  const wrong = (was: string) =>
    new Error(
      `${field} is wrongly formed: an amount is recorded as a decimal string of whole cents from 1 (never a JSON ` +
        `number, never "0", no sign and no leading zero), was ${was}`,
    );
  if (typeof value !== 'string') throw wrong(typeof value === 'number' ? `the JSON number ${value}` : String(value));
  let cents: bigint;
  try {
    cents = toBigInt(value, field);
  } catch {
    throw wrong(`the text '${value}'`);
  }
  // `toBigInt` takes a sign and leading zeros; a recorded amount is written one way only.
  if (cents < 1n || cents.toString() !== value) throw wrong(`the text '${value}'`);
  return cents;
}

/**
 * A step chance as the contract's `chanceCompact` writes it (upgrade-step contract §4, the perimeter's
 * DisplayRounding.renderFloor): percent with 2 decimals, a "." and a "%", rounded DOWN to 0.01 %, so it is
 * never above the true chance; a chance from 1 to 99 ppm is "< 0.01%", never "0.00%"; 1 000 000 ppm is
 * "100.00%"; 0 is not a chance and is refused. 416 666 ppm is "41.66%".
 *
 * Written here on its own, in integers, and never shared with the page's display code: a check that
 * reused the page's function would let one rounding bug pass on both sides (KAN-1154 E1b review rule).
 */
export function stepChanceText(ppm: number): string {
  if (!Number.isInteger(ppm) || ppm < 1 || ppm > PPM_TOTAL) {
    throw new Error(`a shown chance is an integer in [1, ${PPM_TOTAL}] ppm, was ${ppm}`);
  }
  if (ppm < 100) return '< 0.01%';
  const hundredthsOfPercent = (ppm - (ppm % 100)) / 100;
  const whole = (hundredthsOfPercent - (hundredthsOfPercent % 100)) / 100;
  return `${whole}.${String(hundredthsOfPercent % 100).padStart(2, '0')}%`;
}

/** The two-entry table an upgrade step draws over: slot 0 holds the chance and wins, slot 1 loses. */
export function stepTable(chancePpm: number): Pick<SlotOdds, 'slotIndex' | 'probabilityPpm'>[] {
  if (!Number.isInteger(chancePpm) || chancePpm < 1 || chancePpm >= PPM_TOTAL) {
    throw new Error(`a step chance must be an integer in [1, ${PPM_TOTAL - 1}], was ${chancePpm}`);
  }
  return [
    { slotIndex: 0, probabilityPpm: chancePpm },
    { slotIndex: 1, probabilityPpm: PPM_TOTAL - chancePpm },
  ];
}

/**
 * How a step at `chancePpm` ends for the drawn value `v`: the same cumulative lookup as a box, over
 * {@link stepTable}. Slot 0 is `won`, so a step is won exactly when `v < chancePpm`.
 */
export function stepOutcome(v: number, chancePpm: number): 'won' | 'lost' {
  return slotFor(v, stepTable(chancePpm)) === 0 ? 'won' : 'lost';
}

/**
 * The slot an upgrade win holds, from its step's drawn value: the target of the step from `stakedSlot`
 * under the edition's version, when that step's chance is `chancePpm` and `v` wins at it; otherwise no
 * slot, with the reason. Version 1's target is the offer; version 2's is the slot the win records
 * (`recordedSlot`), when it is a target of the staked slot. Any other version holds no slot.
 */
function upgradeWinSlot(
  v: number,
  chancePpm: number,
  edition: Edition,
  stakedSlot: number,
  recordedSlot: number,
  rule: UpgradeRule | undefined,
  boostCents: bigint,
): { outcome: 'won' | 'lost'; slotIndex?: number; why: string } {
  const outcome = stepOutcome(v, chancePpm);
  if (outcome === 'lost') return { outcome, why: `none: ${v} loses at a chance of ${chancePpm} ppm` };
  if (rule === undefined) return { outcome, why: `none: ${unknownVersionWhy(edition.engineVersion)}` };
  const offer = stepFor(edition, rule, stakedSlot, recordedSlot);
  if (offer === null) return { outcome, why: `none: ${noStepWhy(rule, stakedSlot, recordedSlot)}` };
  const fair = winChancePpm(edition, rule, stakedSlot, offer, boostCents);
  if (fair !== chancePpm) {
    return { outcome, why: `none: the step from slot ${stakedSlot} has a chance of ${fair} ppm, not ${chancePpm}` };
  }
  return { outcome, slotIndex: offer.targetSlotIndex, why: '' };
}

/**
 * The fair chance of the step that made an upgraded win: the target's chance with no amount, or on a version
 * with an amount, the chance with the amount the open record carries (absent is 0). The limits on that amount
 * are checked first, by {@link winAmountWrong}.
 */
function winChancePpm(edition: UpgradeEditionOdds, rule: UpgradeRule, stakedSlot: number, offer: UpgradeOffer, boostCents: bigint): number {
  if (rule.boostCeilingCents === undefined || boostCents === 0n) return offer.chancePpm;
  return boostChancePpm(boostStepOf(edition, rule, stepRate(edition, rule), stakedSlot, offer.targetSlotIndex), boostCents);
}

/**
 * The amount an upgraded win's open record carries, against its version (plan v1.1 L9), or undefined when it
 * holds. Present on a version with no amount fails; on a version with one, the engine's limits are the
 * step's own ({@link boostStepLimits}), so the open page and the step page cannot disagree on a limit. Needs
 * no seed, so it fails before the reveal too. Undefined as well when the step itself has no fair chance (the
 * version, the rate or the target): that cause is reported by the chance check, as on every version.
 *
 * The words, which the page reads (site `words.ts`): expected `amount recorded <b> cents`; computed
 * `amount refused, version <v> of the upgrade rules has no amount`, or `amount refused, <the limit>` in the
 * forms of {@link boostLimitWhy}.
 */
function winAmountWrong(input: VerificationInput, rule: UpgradeRule | undefined): Check | undefined {
  const recorded = input.expected.stepBoostCents;
  if (recorded === undefined || rule === undefined) return undefined;
  const amount = BigInt(recorded);
  const expected = `amount recorded ${amount} cents`;
  if (rule.boostCeilingCents === undefined) {
    return { ok: false, expected, computed: `amount refused, version ${rule.engineVersion} of the upgrade rules has no amount` };
  }
  const stakedSlot = input.expected.stakedSlotIndex as number;
  const offer = attempt(() => stepFor(input.edition, rule, stakedSlot, input.expected.drawnSlotIndex));
  if (!offer.ok || offer.value === null) return undefined;
  const target = offer.value.targetSlotIndex;
  const limits = boostStepLimits(boostStepOf(input.edition, rule, stepRate(input.edition, rule), stakedSlot, target), amount);
  return limits.ok ? undefined : { ok: false, expected, computed: `amount refused, ${boostLimitWhy(limits, amount)}` };
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
 * Verify one open end to end, offline. Never throws.
 *
 * Every check is computed on its own, so one unusable input fails the checks that need it and
 * leaves the others standing. Example: a table whose chances add up to 1,000,001 fails
 * `editionFingerprint` with an `error`; the commitment and the draw are still recomputed and shown,
 * and the slot lookup, which needs the table, is listed in `notRun`.
 *
 * The commitment is listed first because a broken commitment means the revealed seed is not the
 * committed one and nothing downstream is worth reading; the fingerprint next, because a mismatch
 * there means the odds are unverified and a matching slot proves nothing.
 */
export async function verify(input: VerificationInput, options: UpgradeStepOptions = {}): Promise<VerificationReport> {
  try {
    return await verifyChecked(input, options);
  } catch (error) {
    return invalidReport(error);
  }
}

/**
 * {@link verify}, with the parsing inside the same guard: `build` is where {@link parseEdition} and
 * {@link parseSnapshotBody} run, and anything they refuse becomes an `invalid` report rather than
 * an exception. One call, one result, whatever was pasted.
 */
export async function verifyFrom(build: () => VerificationInput, options: UpgradeStepOptions = {}): Promise<VerificationReport> {
  let input: VerificationInput;
  try {
    input = build();
  } catch (error) {
    return invalidReport(error);
  }
  return verify(input, options);
}

/** The checks a `verified` report must have run: the commitment, the odds, the draw and the slot. */
const CORE_CHECKS = ['commitment', 'editionFingerprint', 'drawnPpmValue', 'drawnSlotIndex'] as const;

const SEED_NOT_REVEALED = 'the server seed has not been revealed yet; it is published when its seed pair retires';
const NO_SNAPSHOT = 'no prize-table snapshot was supplied';

async function verifyChecked(input: VerificationInput, options: UpgradeStepOptions): Promise<VerificationReport> {
  requireShape(input);
  const checks: VerificationReport['checks'] = {};
  const notRun: NotRun[] = [];
  const trace: VerificationReport['trace'] = {};
  const caveats: string[] = [];
  // An upgraded win's step is read under its version's rule, or under the demo set for a dev-listed step.
  const upgradeRules = ruleSetOf(options);
  const winRule = upgradeRules.find((r) => r.engineVersion === input.edition.engineVersion);
  if (input.gameKind === 'upgrade' && options.demoRules !== undefined) {
    trace.ruleSet = options.demoRules.name;
    caveats.push(DEMO_CAVEAT);
  }
  const skip = (check: CheckName, reason: string) => notRun.push({ check, reason });
  const seedRevealed = input.serverSeedHex !== null;

  // Step 2 — the odds. Needs no seed, so it runs for a pending open too.
  const expectedFingerprint = input.expected.editionFingerprint.toLowerCase();
  let computedFingerprint: string | undefined;
  const preimage = attempt(() => editionBytes(input.edition));
  if (preimage.ok) {
    computedFingerprint = hexFromBytes(await sha256(preimage.value));
    trace.editionPreimageHex = hexFromBytes(preimage.value);
    trace.computedEditionFingerprint = computedFingerprint;
    trace.cumulative = cumulativeTable(input.edition.slots);
    checks.editionFingerprint = check(expectedFingerprint, computedFingerprint);
  } else {
    checks.editionFingerprint = unusable(expectedFingerprint, 'edition', preimage.error);
  }

  // Steps 1 and 3 — the commitment and the draw. Both need the revealed seed.
  let derivation: Derivation | undefined;
  if (input.serverSeedHex === null) {
    // Its shape needs no seed: a commitment that is not 64 hex characters can never be matched.
    if (/^[0-9a-f]{64}$/i.test(input.commitmentHex)) skip('commitment', SEED_NOT_REVEALED);
    else checks.commitment = unusable(input.commitmentHex, 'commitmentHex', 'the commitment must be 64 hex characters');
    skip('drawnPpmValue', SEED_NOT_REVEALED);
  } else {
    const seedHex = input.serverSeedHex;
    const seed = attempt(() => {
      const bytes = bytesFromHex(seedHex);
      requireSeed(bytes);
      return bytes;
    });
    const expectedPpm = String(input.expected.drawnPpmValue);
    if (!seed.ok) {
      checks.commitment = unusable(input.commitmentHex.toLowerCase(), 'serverSeedHex', seed.error);
      skip('drawnPpmValue', 'it needs the revealed server seed, which is unusable');
    } else {
      checks.commitment = check(input.commitmentHex.toLowerCase(), await commitment(seed.value));
      const clientSeed = attempt(() => requireClientSeed(input.clientSeed));
      const nonce = attempt(() => requireNonce(input.nonce));
      if (!clientSeed.ok) {
        checks.drawnPpmValue = unusable(expectedPpm, 'clientSeed', clientSeed.error);
      } else if (!nonce.ok) {
        checks.drawnPpmValue = unusable(expectedPpm, 'nonce', nonce.error);
      } else {
        derivation = await derive(seed.value, input.clientSeed, input.nonce);
        Object.assign(trace, derivation);
        checks.drawnPpmValue = check(expectedPpm, String(derivation.value));
      }
    }
  }

  // Step 4 — the slot. Needs the draw and a usable table.
  // An upgraded win is never read over the box's ranges: its table is the step's, set below once v is known.
  if (input.gameKind === 'upgrade') delete trace.cumulative;
  // The amount the win's record carries, against the limits of its version: needs no seed, so it is decided
  // first and is the cause reported, locked or revealed (plan v1.1 L9).
  const amountWrong = input.gameKind === 'upgrade' && preimage.ok ? winAmountWrong(input, winRule) : undefined;
  let computedSlotIndex: number | undefined;
  if (derivation === undefined) {
    // The chance shown with an upgrade win needs no seed: its fair text comes from the edition and the staked
    // slot alone, so a wrong text fails now instead of reading pending until the reveal (owner ruling, KAN-1154).
    const shownWrong = amountWrong ?? (input.gameKind === 'upgrade' && preimage.ok ? wrongChanceText(input, winRule) : undefined);
    if (shownWrong !== undefined) checks.drawnSlotIndex = shownWrong;
    else skip('drawnSlotIndex', seedRevealed ? 'it needs the drawn value, which could not be computed' : SEED_NOT_REVEALED);
  } else if (!preimage.ok) {
    skip('drawnSlotIndex', 'it needs the prize table, which is unusable');
  } else if (input.gameKind === 'upgrade') {
    // An upgrade win was drawn over the step's table, so the box table must not decide its slot.
    const chancePpm = input.expected.stepChancePpm as number;
    const expectedSlot = String(input.expected.drawnSlotIndex);
    const stakedSlot = input.expected.stakedSlotIndex as number;
    const boostCents = BigInt(input.expected.stepBoostCents ?? 0);
    const step = attempt(() =>
      upgradeWinSlot(derivation!.value, chancePpm, input.edition, stakedSlot, input.expected.drawnSlotIndex, winRule, boostCents),
    );
    if (!step.ok) {
      checks.drawnSlotIndex = unusable(expectedSlot, 'expected.stepChancePpm', step.error);
    } else {
      trace.cumulative = cumulativeTable(stepTable(chancePpm));
      trace.computedStepOutcome = step.value.outcome;
      if (step.value.slotIndex !== undefined) {
        computedSlotIndex = step.value.slotIndex;
        trace.computedSlotIndex = computedSlotIndex;
      }
      const slotCheck =
        step.value.outcome !== input.expected.stepOutcome
          ? { ok: false, expected: `step ${input.expected.stepOutcome}`, computed: `step ${step.value.outcome}` }
          : check(expectedSlot, step.value.slotIndex === undefined ? step.value.why : String(step.value.slotIndex));
      // A slot reached only when the claimed chance is the fair one (upgradeWinSlot), so the shown text is
      // compared with the text of the FAIR chance: one rule for every chance (contract §7, eleonora 24614, A).
      const shown = input.expected.stepChanceCompact as string;
      const fairText = slotCheck.ok ? stepChanceText(chancePpm) : undefined;
      checks.drawnSlotIndex =
        fairText !== undefined && shown !== fairText
          ? { ok: false, expected: `chance shown ${shown}`, computed: `fair chance ${fairText}` }
          : slotCheck;
    }
    if (amountWrong !== undefined) {
      checks.drawnSlotIndex = amountWrong;
      delete trace.computedSlotIndex;
      computedSlotIndex = undefined;
    }
    // On a version whose steps name their own target, the slot here is the one the win records: this run
    // proves it is an allowed target, not that it is the target the step named.
    // Each version's own words (L8); a version this library does not check keeps version 1's general words.
    const winCaveat = (winRule === undefined ? undefined : UPGRADE_CAVEATS_BY_VERSION[winRule.engineVersion]?.win) ?? nextUpWinCaveat;
    const recordedAmount = input.expected.stepBoostCents === undefined ? undefined : BigInt(input.expected.stepBoostCents);
    caveats.push(winCaveat(stakedSlot, input.expected.drawnSlotIndex, input.expected.upgradeStepId, recordedAmount));
  } else {
    computedSlotIndex = slotFor(derivation.value, input.edition.slots);
    trace.computedSlotIndex = computedSlotIndex;
    checks.drawnSlotIndex = check(String(input.expected.drawnSlotIndex), String(computedSlotIndex));
  }

  // Step 4 — the item, through the published snapshot.
  if (!input.snapshot) {
    skip('snapshotHash', NO_SNAPSHOT);
    skip('snapshotEditionLink', NO_SNAPSHOT);
    skip('drawnItemId', NO_SNAPSHOT);
    caveats.push(
      `NOT VERIFIED: which item filled ${slotWords(computedSlotIndex)}. This run checks that the revealed ` +
        'seed reproduces the drawn value and that the value lands on this slot, under odds that match ' +
        'their fingerprint — but no prize-table snapshot was supplied, and nothing here looked at items. ' +
        'A draw and odds that pass these checks can still be paired with a misreported prize. Supply ' +
        'the published snapshot to close that gap.',
    );
  } else {
    const snapshot = input.snapshot;
    const expectedHash = input.expected.snapshotHash?.toLowerCase();
    const snapshotPreimage = attempt(() => snapshotBytes(snapshot));
    if (!snapshotPreimage.ok) {
      checks.snapshotHash = unusable(expectedHash ?? '', 'snapshot', snapshotPreimage.error);
    } else {
      const computedSnapshotHash = hexFromBytes(await sha256(snapshotPreimage.value));
      trace.snapshotPreimageHex = hexFromBytes(snapshotPreimage.value);
      trace.computedSnapshotHash = computedSnapshotHash;
      checks.snapshotHash =
        expectedHash === undefined
          ? unusable('', 'expected.snapshotHash', 'a snapshot was supplied without the snapshot hash recorded on the win')
          : check(expectedHash, computedSnapshotHash);
    }

    if (computedFingerprint === undefined) {
      skip('snapshotEditionLink', 'it needs the edition fingerprint, which could not be computed');
    } else {
      // The fingerprint inside the list AND the slots it lists: exactly the box's slots 0..n-1. A
      // list that leaves a slot out can otherwise hash cleanly and say nothing about that slot.
      const link = check(computedFingerprint, snapshot.editionFingerprint.toLowerCase());
      const boxSlots = input.edition.slots.map((s) => s.slotIndex).sort((a, b) => a - b).join(',');
      const listSlots = snapshot.slots.map((s) => s.slotIndex).sort((a, b) => a - b).join(',');
      // A different set of slots is a mismatch, not an unusable input: the comparison was made, and
      // `expected`/`computed` then hold the two slot lists.
      checks.snapshotEditionLink =
        link.ok && listSlots !== boxSlots ? { ok: false, expected: boxSlots, computed: listSlots } : link;
    }

    // The slot the MATHS selected, never the one we were told — checking the claimed slot's item
    // against the claimed item would be circular.
    let itemIdInDrawnSlot: string | undefined;
    if (computedSlotIndex !== undefined) {
      const filled = snapshot.slots.find((slot) => slot.slotIndex === computedSlotIndex);
      if (filled) {
        itemIdInDrawnSlot = filled.currentItemId.toLowerCase();
        trace.itemIdInDrawnSlot = itemIdInDrawnSlot;
      }
    }
    if (computedSlotIndex !== undefined && itemIdInDrawnSlot === undefined) {
      // A prize list with no entry for the slot you won says nothing about your item: that FAILS,
      // with or without an item id to compare. No stand-in text, so no input can ever equal it.
      checks.drawnItemId = unusable(
        input.expected.itemId?.toLowerCase() ?? '',
        'snapshot.slots',
        `the prize list has no entry for slot ${computedSlotIndex}`,
      );
    } else if (input.expected.itemId === undefined) {
      skip('drawnItemId', 'no item id was supplied to compare with');
      caveats.push(
        `NOT VERIFIED: the item recorded for this win. The published snapshot puts ` +
          `${itemIdInDrawnSlot === undefined ? 'an item' : `item ${itemIdInDrawnSlot}`} in ` +
          `${slotWords(computedSlotIndex)}, but no item id was supplied, so nothing was compared with it.`,
      );
    } else if (itemIdInDrawnSlot === undefined) {
      skip('drawnItemId', seedRevealed ? 'it needs the drawn slot, which could not be computed' : SEED_NOT_REVEALED);
    } else {
      // Compared as the 16 bytes the hash covers, so a rendering without hyphens is the same item.
      const expectedItem = input.expected.itemId.toLowerCase();
      checks.drawnItemId = { ...check(expectedItem, itemIdInDrawnSlot), ok: uuidKey(expectedItem) === uuidKey(itemIdInDrawnSlot) };
    }
  }

  if (!seedRevealed) {
    caveats.push(
      'NOT VERIFIED: the draw. The server seed of this seed pair has not been revealed yet, so the ' +
        'commitment, the drawn value and the slot cannot be recomputed. Only the checks listed in ' +
        '`checks` ran.',
    );
  }

  const failed = CHECK_NAMES.filter((name) => checks[name]?.ok === false);
  // Defence in depth: with the seed revealed and nothing failed, the four core checks have always
  // run today. This keeps a later skip from turning into a `verified` that checked less.
  const coreRan = CORE_CHECKS.every((name) => checks[name]?.ok === true);
  // A check that ran and failed fails the open, whatever is still pending.
  const status: VerificationStatus =
    failed.length > 0 ? 'failed' : !seedRevealed ? 'pending' : coreRan ? 'verified' : 'failed';

  const report: VerificationReport = {
    ok: status === 'verified',
    status,
    notRun,
    checks,
    trace,
    caveats,
    summary: summaryOf(status, failed, input, trace),
  };
  const first = failed[0];
  if (first !== undefined) report.firstFailure = failureOf(first, checks[first] as Check);
  return report;
}

function summaryOf(
  status: VerificationStatus,
  failed: CheckName[],
  input: VerificationInput,
  trace: VerificationReport['trace'],
): string {
  if (status === 'pending') {
    return 'PENDING: the server seed has not been revealed yet, so the draw cannot be checked. Every check that could run matched.';
  }
  if (status === 'failed') return `FAILED: ${failed.join(', ')} did not match. This open is not verified.`;

  const item =
    input.snapshot === undefined
      ? '. The item in that slot was NOT verified — see caveats.'
      : input.expected.itemId === undefined
        ? '. The item recorded for the win was NOT compared — see caveats.'
        : `, and the prize table pinned to that edition puts item ${trace.itemIdInDrawnSlot} in it.`;
  return (
    `Verified: nonce ${input.nonce} draws ppm ${trace.value}, which lands on slot ` +
    `${trace.computedSlotIndex} of an edition whose published odds match its recorded fingerprint${item}`
  );
}

function failureOf(name: CheckName, failed: Check): Failure {
  const failure: Failure = {
    check: name,
    step: STEP_OF[name],
    message: failed.error ?? `expected ${failed.expected}, computed ${failed.computed}`,
  };
  if (failed.field !== undefined) failure.field = failed.field;
  return failure;
}

function invalidReport(error: unknown): VerificationReport {
  // Only this library's own refusals are worded for a reader. Anything else (a TypeError from a
  // value of the wrong type) keeps its runtime text in `detail`, never in the message.
  const own = error instanceof Error && error.constructor === Error;
  const message = own
    ? error.message
    : error instanceof SyntaxError
      ? 'the input could not be read: it is not valid JSON'
      : 'the input could not be read: a value has the wrong type';
  const invalid: { message: string; detail?: string } = { message };
  if (!own) invalid.detail = messageOf(error);
  return {
    ok: false,
    status: 'invalid',
    invalid,
    notRun: CHECK_NAMES.map((check) => ({ check, reason: 'the input could not be read' })),
    checks: {},
    trace: {},
    caveats: [],
    summary: `CANNOT CHECK: ${message}`,
  };
}

function slotWords(slotIndex: number | undefined): string {
  return slotIndex === undefined ? 'the drawn slot' : `slot ${slotIndex}`;
}

/** Stands in for the computed value of a check whose input was unusable. */
const NOT_COMPUTED = '(could not be computed)';

function check(expected: string, computed: string): Check {
  return { ok: expected === computed, expected, computed };
}

function unusable(expected: string, field: string, error: string): Check {
  return { ok: false, expected, computed: NOT_COMPUTED, error, field };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs one input guard or preimage builder, turning its refusal into a value a check can report. */
function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** A UUID as the 16 bytes it encodes: hyphens and case do not change which item it names. */
function uuidKey(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

/**
 * The seed-free facts of a locked upgrade win, or undefined when they all hold. Each needs only the edition,
 * the staked slot and, on version 2, the recorded slot, so it fails before the reveal (owner ruling,
 * KAN-1154): a slot the box does not hold, a step the version does not allow, or a version this library does
 * not check has no fair chance, so no shown chance can be fair; a recorded chance that is not the fair one is
 * wrong whatever v is (the shown text is compared first). The causes keep the two prefixes the page reads
 * ("chance shown" or "chance recorded", then "fair chance").
 */
function wrongChanceText(input: VerificationInput, rule: UpgradeRule | undefined): Check | undefined {
  const stakedSlot = input.expected.stakedSlotIndex as number;
  const shown = input.expected.stepChanceCompact as string;
  // Version 2's fair chance depends on the target too, which the win records as its own slot.
  const targetSlot = input.expected.drawnSlotIndex;
  if (rule === undefined) {
    return { ok: false, expected: `chance shown ${shown}`, computed: `fair chance none, ${unknownVersionWhy(input.edition.engineVersion)}` };
  }
  const rate = attempt(() => stepRate(input.edition, rule));
  if (!rate.ok) return { ok: false, expected: `chance shown ${shown}`, computed: `fair chance none, ${rate.error}` };
  const offer = attempt(() => stepFor(input.edition, rule, stakedSlot, targetSlot));
  if (!offer.ok) {
    return { ok: false, expected: `chance shown ${shown}`, computed: `fair chance none, slot ${stakedSlot} is not in the box` };
  }
  if (offer.value === null) {
    return { ok: false, expected: `chance shown ${shown}`, computed: `fair chance none, ${noStepWhy(rule, stakedSlot, targetSlot)}` };
  }
  // On version 4 the fair chance is the one with the amount the record carries (absent is 0); its limits held.
  const fair = winChancePpm(input.edition, rule, stakedSlot, offer.value, BigInt(input.expected.stepBoostCents ?? 0));
  const fairText = stepChanceText(fair);
  if (shown !== fairText) return { ok: false, expected: `chance shown ${shown}`, computed: `fair chance ${fairText}` };
  const recorded = input.expected.stepChancePpm as number;
  return recorded === fair
    ? undefined
    : { ok: false, expected: `chance recorded ${recorded} ppm`, computed: `fair chance ${fair} ppm` };
}

/**
 * The fields every check reads, refused by name when missing or of the wrong type, so a reader
 * sees which input is wrong instead of a runtime error. `serverSeedHex` must be present: `null`
 * means "not revealed yet", while a missing key is a broken input, never a pending one.
 */
function requireShape(input: VerificationInput): void {
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`${what} is missing or has the wrong type`);
  };
  need(typeof input === 'object' && input !== null, 'the input');
  need(input.serverSeedHex !== undefined, 'serverSeedHex (use null while the seed is not revealed)');
  need(typeof input.commitmentHex === 'string', 'commitmentHex');
  need(typeof input.expected === 'object' && input.expected !== null, 'expected');
  need(typeof input.expected.editionFingerprint === 'string', 'expected.editionFingerprint');
  // `null` and an absent key both mean "no hash recorded": the snapshot step then fails by name.
  need(input.expected.snapshotHash == null || typeof input.expected.snapshotHash === 'string', 'expected.snapshotHash');
  need(input.expected.itemId === undefined || typeof input.expected.itemId === 'string', 'expected.itemId');
  need(input.gameKind === undefined || input.gameKind === 'box_open' || input.gameKind === 'upgrade', 'gameKind');
  if (input.gameKind === 'upgrade') {
    need(typeof input.expected.stepChancePpm === 'number', 'expected.stepChancePpm (required on an upgrade win)');
    need(typeof input.expected.stepChanceCompact === 'string', 'expected.stepChanceCompact (required on an upgrade win)');
    // The fair chance is read from the edition even while the seed is locked, so it must be there to read.
    need(typeof input.edition === 'object' && input.edition !== null && Array.isArray(input.edition.slots), 'edition (required on an upgrade win)');
    need(typeof input.expected.stakedSlotIndex === 'number', 'expected.stakedSlotIndex (required on an upgrade win)');
    need(input.expected.stepOutcome === 'won' || input.expected.stepOutcome === 'lost', 'expected.stepOutcome (required on an upgrade win)');
  }
  // The same wire rule as the step's own amount, through the same check (plan v1.1 L9, NOTE-5).
  recordedAmountCents(input.expected.stepBoostCents, 'expected.stepBoostCents');
  if (input.expected.stepBoostCents !== undefined && input.gameKind !== 'upgrade') {
    throw new Error('expected.stepBoostCents is recorded only with an upgrade win, and this open is not one');
  }
  if (input.snapshot !== undefined) {
    need(typeof input.snapshot.editionFingerprint === 'string', 'snapshot.editionFingerprint');
    need(Array.isArray(input.snapshot.slots), 'snapshot.slots');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// ---------------------------------------------------------------------------
// Verifying one upgrade step — rng-fairness §4b and §6
// ---------------------------------------------------------------------------

/** The engine type of an upgrade edition. Its constants are the cap and the minimum chances above. */
export const UPGRADE_ENGINE_TYPE = 'single_draw_weighted_table_fair_upgrade';

/**
 * Version 1 of the upgrade engine: the next value up only, at 10 % or more. The version the fixture's
 * `upgradeStep` and `upgradeOffer` families state. {@link UPGRADE_RULES} lists every version this library
 * checks; a step on any other is failed, never checked by another version's rules (§6: version for
 * version, fail closed).
 */
export const UPGRADE_ENGINE_VERSION = 1;

/**
 * The step's return to player in basis points: 10 000, a fair step. {@link upgradeChancePpm} is the
 * chance at exactly this value; the fixture states it, and the conformance suite compares the two.
 */
export const UPGRADE_STEP_RTP_BPS = 10_000;

/** Everything needed to verify one upgrade step, won or lost. Assemble it from the published step. */
export interface UpgradeStepInput {
  /** The revealed server seed of the step's seed pair, 64 hex characters, or `null` while it is active. */
  serverSeedHex: string | null;
  commitmentHex: string;
  clientSeed: string;
  /** The nonce the step drew on. */
  nonce: number;
  /** The published edition of the box, whose fingerprint binds the two buy-back values the chance comes from. */
  edition: Edition;
  /** The edition's engine type, as the step answer gives it. The `0x01` bytes bind the engine id, not the type. */
  engineType: string;
  /** What the platform says happened. Every field here is a claim this function tries to refute. */
  expected: {
    editionFingerprint: string;
    stakedSlotIndex: number;
    targetSlotIndex: number;
    chancePpm: number;
    /** The chance as the step answer writes it for a player (contract §6). Checked against the fair chance. */
    chanceCompact: string;
    drawnPpmValue: number;
    outcome: 'won' | 'lost';
    stepNo: number;
    /**
     * Version 4 only: the amount recorded as added to the value staked, a decimal string of whole cents from 1.
     * Absent when none was added; any other shape (a JSON number, "0", a fraction) makes the step unreadable.
     */
    boostCents?: string;
  };
}

/** The names of the step checks, in the order a reader should meet them. */
export const UPGRADE_STEP_CHECK_NAMES = [
  'commitment',
  'editionFingerprint',
  'engineType',
  'engineVersion',
  'upgradeTarget',
  'upgradeChance',
  'boostAmount',
  'chanceCompact',
  'stepNo',
  'drawnPpmValue',
  'upgradeOutcome',
] as const;

export type UpgradeStepCheckName = (typeof UPGRADE_STEP_CHECK_NAMES)[number];

/** The step's verdict: the same statuses, `notRun` and caveat rules as {@link VerificationReport}. */
export interface UpgradeStepReport {
  ok: boolean;
  status: VerificationStatus;
  firstFailure?: { check: UpgradeStepCheckName; field?: string; message: string };
  invalid?: { message: string; detail?: string };
  notRun: { check: UpgradeStepCheckName; reason: string }[];
  checks: Partial<Record<UpgradeStepCheckName, Check>>;
  trace: Partial<Derivation> & {
    editionPreimageHex?: string;
    computedEditionFingerprint?: string;
    /**
     * The step the edition allows from the staked slot: version 1's offer, or version 2's entry for the
     * recorded target. Absent when there is none.
     */
    computedOffer?: UpgradeOffer;
    /**
     * The step return the chance was computed at, in basis points: 10 000 on versions 1 and 2, and on
     * version 3 the box's rate, computed from the edition above. Absent when it could not be read.
     */
    stepRateBps?: number;
    /** The rule set the step was checked under, when it is not the default: only `DEMO_RULES_2026_11_17`. */
    ruleSet?: string;
    /** The step's two-entry table as a cumulative lookup: slot 0 wins. */
    cumulative?: CumulativeRow[];
    computedOutcome?: 'won' | 'lost';
  };
  caveats: string[];
  summary: string;
}

/**
 * Verify one upgrade step: the commitment, the odds, that the edition is an upgrade edition on a version
 * this library checks, that the target is one its version allows from the staked slot (version 1: the next
 * value up; version 2: any higher value at 1 % or more) and the chance its fair floor, that the step
 * number is within the cap, that the seed reproduces the drawn value, and that this value reads as the
 * recorded outcome over the step's own table. A lost step verifies exactly like a won one.
 */
export async function verifyUpgradeStep(input: UpgradeStepInput, options: UpgradeStepOptions = {}): Promise<UpgradeStepReport> {
  try {
    return await verifyStepChecked(input, options);
  } catch (error) {
    const own = error instanceof Error && error.constructor === Error;
    const message = own ? error.message : 'the input could not be read: a value has the wrong type';
    const invalid: { message: string; detail?: string } = { message };
    if (!own) invalid.detail = messageOf(error);
    return {
      ok: false,
      status: 'invalid',
      invalid,
      notRun: UPGRADE_STEP_CHECK_NAMES.map((check) => ({ check, reason: 'the input could not be read' })),
      checks: {},
      trace: {},
      caveats: [],
      summary: `CANNOT CHECK: ${message}`,
    };
  }
}

async function verifyStepChecked(input: UpgradeStepInput, options: UpgradeStepOptions): Promise<UpgradeStepReport> {
  requireStepShape(input);
  const checks: UpgradeStepReport['checks'] = {};
  const notRun: UpgradeStepReport['notRun'] = [];
  const trace: UpgradeStepReport['trace'] = {};
  const caveats: string[] = [];
  const skip = (check: UpgradeStepCheckName, reason: string) => notRun.push({ check, reason });
  const seedRevealed = input.serverSeedHex !== null;
  const expected = input.expected;

  // The odds, and what they allow from the staked slot under the edition's version. None of this needs the seed.
  const expectedFingerprint = expected.editionFingerprint.toLowerCase();
  const preimage = attempt(() => editionBytes(input.edition));
  // Bound by the fingerprint: engineVersion is inside the `0x01` preimage, so it picks the rule. The demo
  // rule set is taken only as the library's own object, never as a look-alike.
  const rules = ruleSetOf(options);
  const rule = rules.find((r) => r.engineVersion === input.edition.engineVersion);
  if (options.demoRules !== undefined) {
    trace.ruleSet = options.demoRules.name;
    caveats.push(DEMO_CAVEAT);
  }
  let offer: Attempt<UpgradeOffer | null> | undefined;
  let rate: Attempt<number> | undefined;
  if (preimage.ok) {
    const computedFingerprint = hexFromBytes(await sha256(preimage.value));
    trace.editionPreimageHex = hexFromBytes(preimage.value);
    trace.computedEditionFingerprint = computedFingerprint;
    checks.editionFingerprint = check(expectedFingerprint, computedFingerprint);
    if (rule !== undefined) {
      // The rate first, from the same edition: on version 3 a box whose rate cannot be read has no fair step.
      rate = attempt(() => stepRate(input.edition, rule));
      if (rate.ok) {
        trace.stepRateBps = rate.value;
        offer = attempt(() => stepFor(input.edition, rule, expected.stakedSlotIndex, expected.targetSlotIndex));
      }
    }
  } else {
    checks.editionFingerprint = unusable(expectedFingerprint, 'edition', preimage.error);
  }
  checks.engineType = check(UPGRADE_ENGINE_TYPE, input.engineType);
  checks.engineVersion = check(
    rule === undefined ? rules.map((r) => r.engineVersion).join(' or ') : String(rule.engineVersion),
    String(input.edition.engineVersion),
  );
  caveats.push(
    'The engine type is read from the published engine row. The edition fingerprint binds the engine id, ' +
      'and an engine row cannot be changed after it is published; this run did not look at that row itself.',
  );

  // The amount recorded with the step. A version with no amount needs only its rule to check it: the amount
  // must be absent. On a version with one, the limits need the two values, so they wait for the target.
  const recordedAmount = expected.boostCents === undefined ? undefined : BigInt(expected.boostCents);
  const boosts = rule?.boostCeilingCents !== undefined;
  const amountWaits = (why: string) => {
    if (boosts || rule === undefined) skip('boostAmount', why);
  };
  if (rule !== undefined && !boosts) {
    checks.boostAmount =
      recordedAmount === undefined
        ? check('no amount', 'no amount')
        : {
            ok: false,
            expected: `no amount: version ${rule.engineVersion} of the upgrade rules has none`,
            computed: `${recordedAmount} cents`,
          };
  }

  let chance: number | undefined;
  if (rate !== undefined && !rate.ok) {
    skip('upgradeTarget', 'it needs the box\'s rate, which could not be read from the edition');
    checks.upgradeChance = unusable(String(expected.chancePpm), 'edition', rate.error);
    amountWaits('it needs the box\'s rate, which could not be read from the edition');
    skip('chanceCompact', 'it needs the step chance, which could not be computed');
  } else if (offer === undefined) {
    // A version with no rule here is never read by another version's rule: the step's maths are not run.
    const why = !preimage.ok ? 'it needs the prize table, which is unusable' : unknownVersionWhy(input.edition.engineVersion);
    skip('upgradeTarget', why);
    skip('upgradeChance', why);
    amountWaits(why);
    skip('chanceCompact', 'it needs the step chance, which could not be computed');
  } else if (!offer.ok) {
    checks.upgradeTarget = unusable(String(expected.targetSlotIndex), 'expected.stakedSlotIndex', offer.error);
    skip('upgradeChance', 'it needs the target, which could not be computed');
    amountWaits('it needs the target, which could not be computed');
    skip('chanceCompact', 'it needs the step chance, which could not be computed');
  } else if (offer.value === null) {
    // An offer is only computed under a rule, so `rule` is set here.
    const stepRule = rule as UpgradeRule;
    checks.upgradeTarget = {
      ok: false,
      expected: String(expected.targetSlotIndex),
      computed: `none: ${noStepWhy(stepRule, expected.stakedSlotIndex, expected.targetSlotIndex)}`,
    };
    const why = stepRule.jumps
      ? 'the edition allows no step from the staked slot to the target'
      : 'the edition offers no step from the staked slot';
    skip('upgradeChance', why);
    amountWaits(why);
    skip('chanceCompact', why);
  } else {
    trace.computedOffer = offer.value;
    chance = offer.value.chancePpm;
    checks.upgradeTarget = check(String(expected.targetSlotIndex), String(offer.value.targetSlotIndex));
    if (boosts) {
      // The target was found at the chance with no amount, so the version's minimum holds already. The amount
      // is checked against the engine's limits (boostStepLimits), and the chance is the one with the amount.
      const amount = recordedAmount ?? 0n;
      const step = boostStepOf(input.edition, rule as UpgradeRule, trace.stepRateBps as number, expected.stakedSlotIndex, offer.value.targetSlotIndex);
      const limits = boostStepLimits(step, amount);
      const within = amount === 0n ? 'no amount' : `${amount} cents within the limits of version ${step.engineVersion}`;
      checks.boostAmount = limits.ok ? check(within, within) : { ok: false, expected: within, computed: boostLimitWhy(limits, amount) };
      chance = limits.ok || limits.limit !== 'reachesTarget' ? limits.chancePpm : undefined;
    }
    if (chance === undefined) {
      const why = "it needs the chance with the amount, which cannot be computed: the amount reaches the target's value";
      skip('upgradeChance', why);
      skip('chanceCompact', why);
    } else {
      trace.cumulative = cumulativeTable(stepTable(chance));
      checks.upgradeChance = check(String(expected.chancePpm), String(chance));
      // The string a player reads, against the FAIR chance: a right number with a rounded-up string fails here.
      checks.chanceCompact = check(expected.chanceCompact, stepChanceText(chance));
    }
  }
  // A range check, not a recompute: the chain of earlier steps is not part of one step. The range is the
  // version's limit, or on a version with none the longest chain a box of 30 prizes allows.
  const maxStepNo = rule === undefined ? undefined : (rule.maxSteps ?? UPGRADE_MAX_CHAIN);
  if (maxStepNo === undefined) {
    skip('stepNo', unknownVersionWhy(input.edition.engineVersion));
  } else {
    checks.stepNo = {
      ok: Number.isInteger(expected.stepNo) && expected.stepNo >= 1 && expected.stepNo <= maxStepNo,
      expected: `in range 1..${maxStepNo}`,
      computed: String(expected.stepNo),
    };
    // Each version's own words, never another's (L8): a rule always has its entry in the table.
    caveats.push((UPGRADE_CAVEATS_BY_VERSION[(rule as UpgradeRule).engineVersion]?.stepNo ?? capStepNoCaveat)(maxStepNo));
  }

  // The commitment and the draw. Both need the revealed seed.
  let v: number | undefined;
  const expectedPpm = String(expected.drawnPpmValue);
  if (!seedRevealed) {
    if (/^[0-9a-f]{64}$/i.test(input.commitmentHex)) skip('commitment', SEED_NOT_REVEALED);
    else checks.commitment = unusable(input.commitmentHex, 'commitmentHex', 'the commitment must be 64 hex characters');
    skip('drawnPpmValue', SEED_NOT_REVEALED);
  } else {
    const seedHex = input.serverSeedHex as string;
    const seed = attempt(() => {
      const bytes = bytesFromHex(seedHex);
      requireSeed(bytes);
      return bytes;
    });
    if (!seed.ok) {
      checks.commitment = unusable(input.commitmentHex.toLowerCase(), 'serverSeedHex', seed.error);
      skip('drawnPpmValue', 'it needs the revealed server seed, which is unusable');
    } else {
      checks.commitment = check(input.commitmentHex.toLowerCase(), await commitment(seed.value));
      const clientSeed = attempt(() => requireClientSeed(input.clientSeed));
      const nonce = attempt(() => requireNonce(input.nonce));
      if (!clientSeed.ok) checks.drawnPpmValue = unusable(expectedPpm, 'clientSeed', clientSeed.error);
      else if (!nonce.ok) checks.drawnPpmValue = unusable(expectedPpm, 'nonce', nonce.error);
      else {
        const derivation = await derive(seed.value, input.clientSeed, input.nonce);
        Object.assign(trace, derivation);
        v = derivation.value;
        checks.drawnPpmValue = check(expectedPpm, String(v));
      }
    }
  }

  // The outcome: the DERIVED value over the table of the COMPUTED chance, never the claimed ones.
  if (v === undefined) {
    skip('upgradeOutcome', seedRevealed ? 'it needs the drawn value, which could not be computed' : SEED_NOT_REVEALED);
  } else if (chance === undefined) {
    skip('upgradeOutcome', 'it needs the step chance, which could not be computed');
  } else {
    trace.computedOutcome = stepOutcome(v, chance);
    checks.upgradeOutcome = check(expected.outcome, trace.computedOutcome);
  }

  if (!seedRevealed) {
    caveats.push(
      'NOT VERIFIED: the draw. The server seed of this seed pair has not been revealed yet, so the ' +
        'commitment, the drawn value and the outcome cannot be recomputed.',
    );
  }

  const failed = UPGRADE_STEP_CHECK_NAMES.filter((name) => checks[name]?.ok === false);
  const coreRan = UPGRADE_STEP_CHECK_NAMES.every((name) => checks[name]?.ok === true);
  const status: VerificationStatus =
    failed.length > 0 ? 'failed' : !seedRevealed ? 'pending' : coreRan ? 'verified' : 'failed';

  const report: UpgradeStepReport = {
    ok: status === 'verified',
    status,
    notRun,
    checks,
    trace,
    caveats,
    summary:
      status === 'pending'
        ? 'PENDING: the server seed has not been revealed yet, so the step cannot be checked. Every check that could run matched.'
        : status === 'failed'
          ? `FAILED: ${failed.join(', ')} did not match. This step is not verified.`
          : `Verified: nonce ${input.nonce} draws ppm ${v}, which ${trace.computedOutcome === 'won' ? 'wins' : 'loses'} ` +
            `at a chance of ${chance} ppm` +
            `${recordedAmount === undefined ? '' : ` with an amount of ${recordedAmount} cents recorded`}, ` +
            `the fair step from slot ${expected.stakedSlotIndex} to slot ` +
            `${expected.targetSlotIndex} of an edition whose published odds match its recorded fingerprint.`,
  };
  const first = failed[0];
  if (first !== undefined) {
    const c = checks[first] as Check;
    report.firstFailure = { check: first, message: c.error ?? `expected ${c.expected}, computed ${c.computed}` };
    if (c.field !== undefined) report.firstFailure.field = c.field;
  }
  return report;
}

function requireStepShape(input: UpgradeStepInput): void {
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`${what} is missing or has the wrong type`);
  };
  need(typeof input === 'object' && input !== null, 'the input');
  need(input.serverSeedHex !== undefined, 'serverSeedHex (use null while the seed is not revealed)');
  need(typeof input.commitmentHex === 'string', 'commitmentHex');
  need(typeof input.engineType === 'string', 'engineType');
  need(typeof input.expected === 'object' && input.expected !== null, 'expected');
  const e = input.expected;
  need(typeof e.editionFingerprint === 'string', 'expected.editionFingerprint');
  for (const field of ['stakedSlotIndex', 'targetSlotIndex', 'chancePpm', 'drawnPpmValue', 'stepNo'] as const) {
    need(typeof e[field] === 'number', `expected.${field}`);
  }
  need(e.outcome === 'won' || e.outcome === 'lost', 'expected.outcome');
  need(typeof e.chanceCompact === 'string', 'expected.chanceCompact');
  recordedAmountCents(e.boostCents, 'expected.boostCents');
}
