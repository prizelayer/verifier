/**
 * The conformance suite: every vector in the committed fixture, reproduced by this library.
 *
 * The fixture is generated from the certified Kotlin engine and neither implementation may edit it
 * to make itself pass. That is the entire point — these are not our own expectations written twice,
 * they are the other implementation's output, and agreement here is the cross-implementation claim.
 *
 * The same vectors run again in a real browser (`test/browser.spec.ts`) against the same built file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ACCEPTANCE_THRESHOLD,
  CHUNK_OFFSETS,
  PPM_TOTAL,
  SERVER_SEED_BYTES,
  UPGRADE_ENGINE_TYPE,
  UPGRADE_ENGINE_VERSION,
  UPGRADE_JUMP_MIN_CHANCE_PPM,
  UPGRADE_MAX_STEPS,
  UPGRADE_MIN_CHANCE_PPM,
  UPGRADE_RULES,
  UPGRADE_STEP_RTP_BPS,
  bigEndianUint32,
  boostChancePpm,
  boostDecision,
  boostKeyFor,
  boostKeys,
  boostMaxCents,
  bytesFromHex,
  commitment,
  derive,
  editionBytes,
  editionFingerprint,
  hexFromBytes,
  parseEdition,
  parseSnapshot,
  parseSnapshotBody,
  slotFor,
  snapshotBytes,
  snapshotHash,
  stepChanceText,
  stepOutcome,
  stepTable,
  upgradeChancePpm,
  upgradeStepRateBps,
  upgradeRule,
  upgradeTarget,
  upgradeTargets,
  verify,
  verifyFrom,
  verifyUpgradeStep,
  type BoostDecision,
  type BoostLimits,
  type BoostRefusal,
  type BoostStep,
  type Edition,
  type SlotOdds,
  type UpgradeStepInput,
} from '../src/verifier.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../fixtures/golden-vectors-v1.json', import.meta.url), 'utf8'),
);

const SERVER_SEED = bytesFromHex(FIXTURE.draw.serverSeedHex);

/**
 * Re-space JSON the way Postgres `jsonb` does on output: a space after every `:` and `,` outside
 * of strings. Verified against a real `postgres:16` instance rather than assumed.
 *
 * Done as a TEXT scan, not `JSON.parse` + re-render, and that is the whole point of the test. The
 * parse-and-render version of this helper rounded `-9223372036854775807` to
 * `-9223372036854776000` before it could re-emit it — destroying in the fixture exactly the value
 * the `extreme-signed-displayed-value` vector exists to protect. Real `jsonb` does not, because it
 * holds numbers as `numeric`; only a JavaScript parser loses them.
 *
 * `jsonb` also reorders object KEYS (by length, then bytewise). Not simulated, and it does not need
 * to be: array order is preserved by `jsonb`, so the nth `displayed_value_cents` literal is still
 * the nth slot however the keys within each slot are arranged.
 */
function asJsonb(bodyText: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of bodyText) {
    out += char;
    if (escaped) {
      escaped = false;
    } else if (char === '\\' && inString) {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString && (char === ':' || char === ',')) {
      out += ' ';
    }
  }
  return out;
}

/**
 * Every `family/id` this suite actually asserted, and how many sweep rows it replayed.
 *
 * The loops below iterate the fixture directly, so within a family no vector can be missed. The
 * gap this ledger closes is one level up: the families themselves are named by hand, so a NEW
 * family added on the platform side would be ignored here in silence — and both repositories would
 * stay green while the verifier proved strictly less than the fixture claims. The 0x03 snapshot
 * preimage, which binds a slot to the item in it, arrived in exactly that shape.
 *
 * Recorded at the top of each test body rather than the bottom, so a vector that fails its
 * assertions still counts as attempted and reports one clear failure instead of two.
 */
const asserted = new Set<string>();
let sweepRowsAsserted = 0;

function record(family: string, id: string): void {
  asserted.add(`${family}/${id}`);
}

/** Top-level keys that describe the fixture rather than carrying vectors. Everything else is a family. */
const METADATA_KEYS = new Set(['formatVersion', 'source', 'specification', 'notes']);

describe('fixture contract', () => {
  it('is the format version this library implements', () => {
    assert.equal(FIXTURE.formatVersion, 1);
  });

  it('agrees with the constants compiled into this library', () => {
    const c = FIXTURE.draw.constants;
    assert.equal(c.serverSeedBytes, SERVER_SEED_BYTES);
    assert.equal(c.acceptanceThreshold, ACCEPTANCE_THRESHOLD);
    assert.equal(c.ppmTotal, PPM_TOTAL);
    assert.deepEqual(c.chunkOffsets, [...CHUNK_OFFSETS]);
  });
});

describe('the commitment', () => {
  it('SHA-256 of the raw seed bytes equals the published commitment', async () => {
    assert.equal(await commitment(SERVER_SEED), FIXTURE.draw.commitmentHex);
  });

  it('rejects a seed that is not exactly 32 bytes', async () => {
    await assert.rejects(() => commitment(new Uint8Array(31)), /must be 32 bytes/);
  });
});

describe('the draw — rng-fairness.md §3', () => {
  for (const vector of FIXTURE.draw.vectors) {
    it(`reproduces ${vector.id} byte for byte`, async () => {
      record('draw', vector.id);
      const actual = await derive(SERVER_SEED, vector.clientSeed, vector.nonce);

      assert.equal(actual.message, vector.message);
      assert.equal(actual.hmacHex, vector.hmacHex);
      assert.equal(actual.attempt, vector.attempt);
      assert.equal(actual.offset, vector.offset);
      assert.equal(actual.acceptedChunk, vector.acceptedChunk);
      assert.equal(actual.value, vector.ppm);
      // The rejection trace, not just the answer: a verifier that skipped rejection sampling
      // entirely still reproduces ppm for most nonces, so the discarded chunks are the evidence
      // that the de-biasing loop actually ran.
      assert.deepEqual(actual.rejected, vector.rejected);
    });
  }

  it('every rejected chunk really was at or above the threshold', async () => {
    for (const vector of FIXTURE.draw.vectors) {
      const actual = await derive(SERVER_SEED, vector.clientSeed, vector.nonce);
      for (const rejected of actual.rejected) {
        assert.ok(
          rejected.chunk >= ACCEPTANCE_THRESHOLD,
          `${vector.id}: chunk ${rejected.chunk} was rejected but is below the threshold`,
        );
      }
      assert.ok(actual.acceptedChunk < ACCEPTANCE_THRESHOLD);
    }
  });

  it('reproduces the whole bulk sweep', async () => {
    const { clientSeed, rows } = FIXTURE.draw.sweep;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      sweepRowsAsserted++;
      const actual = await derive(SERVER_SEED, clientSeed, row.nonce);
      assert.deepEqual(
        { nonce: row.nonce, attempt: actual.attempt, offset: actual.offset, ppm: actual.value },
        { nonce: row.nonce, attempt: row.attempt, offset: row.offset, ppm: row.ppm },
      );
    }
  });

  it('rejects a nonce below 1, as the engine does', async () => {
    await assert.rejects(() => derive(SERVER_SEED, 'alice-seed', 0), /positive integer/);
  });
});

describe('the slot mapping — rng-fairness.md §4', () => {
  for (const vector of FIXTURE.slotMapping.vectors) {
    it(`reproduces ${vector.id}`, async () => {
      record('slotMapping', vector.id);
      // slotsAsGiven is deliberately NOT in ascending order. Passing it through untouched is the
      // point: an implementation that walks the published array as-is gets a different slot.
      const derivation = await derive(SERVER_SEED, vector.clientSeed, vector.nonce);
      assert.equal(derivation.value, vector.v);
      assert.equal(slotFor(vector.v, vector.slotsAsGiven), vector.slotIndex);
    });
  }

  it('a table that does not sum to one million is refused', () => {
    assert.throws(
      () => slotFor(0, [{ slotIndex: 0, probabilityPpm: 999_999 }]),
      /must sum to 1000000/,
    );
  });

  it('a table with a gap in its slot indices is refused', () => {
    assert.throws(
      () =>
        slotFor(0, [
          { slotIndex: 0, probabilityPpm: 500_000 },
          { slotIndex: 2, probabilityPpm: 500_000 },
        ]),
      /no gaps or duplicates/,
    );
  });
});

describe('the edition fingerprint — the 0x01 preimage', () => {
  for (const vector of FIXTURE.editionFingerprint.vectors) {
    it(`reproduces ${vector.id}`, async () => {
      record('editionFingerprint', vector.id);
      // slotsAsGiven carries requiredBuyBackRateBps and requiredCategory, which are NOT in the
      // preimage. Feeding them in unfiltered is deliberate: an implementation that hashes them
      // produces a different digest and fails right here.
      const edition = parseEdition({ ...vector.edition, slots: vector.edition.slotsAsGiven });

      assert.equal(hexFromBytes(editionBytes(edition)), vector.preimageHex);
      assert.equal(await editionFingerprint(edition), vector.editionFingerprint);
    });
  }

  it('refuses a cents field that arrived as an unsafe JSON number', () => {
    assert.throws(
      () =>
        parseEdition({
          engineId: '11111111-2222-3333-4444-555555555555',
          engineVersion: 1,
          priceCents: 9_223_372_036_854_775_807,
          slots: [],
        }),
      /published as a decimal string/,
    );
  });

  it('the golden edition matches the digest pinned independently in the Kotlin repo', async () => {
    // Cross-checked against CanonicalSerializerGoldenVectorTest, a different module from the one
    // that generated this fixture. Two independent Kotlin paths and this one all agree.
    const vector = FIXTURE.editionFingerprint.vectors.find(
      (v: { id: string }) => v.id === 'canonical-unsorted-slots',
    );
    const edition = parseEdition({ ...vector.edition, slots: vector.edition.slotsAsGiven });
    assert.equal(
      await editionFingerprint(edition),
      '290fa403670d94b94b80d580c0b86ab79e7628d98421b4ff76ebf2f031a17f44',
    );
  });
});

describe('the snapshot content address — the 0x03 preimage', () => {
  for (const vector of FIXTURE.snapshot.vectors) {
    it(`reproduces ${vector.id}`, async () => {
      record('snapshot', vector.id);
      // slotsAsGiven is unsorted for the multi-slot cases, exactly as in the other families.
      const snapshot = parseSnapshot({
        editionFingerprint: vector.editionFingerprint,
        slots: vector.slotsAsGiven,
      });

      assert.equal(hexFromBytes(snapshotBytes(snapshot)), vector.preimageHex);
      assert.equal(await snapshotHash(snapshot), vector.snapshotHash);
    });

    it(`reproduces ${vector.id} from the published body JSON`, async () => {
      // The production path. `GET /verify/snapshots/{hash}` serves this exact text, so parsing it
      // and rebuilding the preimage is what a real verification does — asserting only against the
      // tidy camelCase form would leave the snake_case parser untested against real bytes.
      assert.equal(await snapshotHash(parseSnapshotBody(vector.body)), vector.snapshotHash);
    });
  }

  it('chains onto the 0x01 edition fingerprint rather than sitting beside it', async () => {
    // The preimage opens with the DECODED edition digest, so verifying a snapshot transitively
    // verifies the odds it was built over. If a snapshot could name any fingerprint it liked, the
    // 0x03 check would prove only that some prize table hashes to some value.
    const canonical = FIXTURE.editionFingerprint.vectors.find(
      (v: { id: string }) => v.id === 'canonical-unsorted-slots',
    );
    for (const vector of FIXTURE.snapshot.vectors) {
      assert.equal(vector.editionFingerprint, canonical.editionFingerprint);
      assert.ok(vector.preimageHex.startsWith('03' + canonical.editionFingerprint));
    }
  });

  it('the fixture still carries media that is longer in UTF-8 bytes than in UTF-16 units', () => {
    // The guard on the guard. displayedMedia's length prefix counts BYTES; String.length counts
    // code units. Every ASCII-only case passes under either reading, so if the fixture's media
    // were ever "tidied" to ASCII this family would go on passing while proving nothing.
    const media: string[] = FIXTURE.snapshot.vectors.flatMap(
      (v: { slotsAsGiven: { displayedMedia: string }[] }) =>
        v.slotsAsGiven.map((s) => s.displayedMedia),
    );
    const multiByte = media.filter((m) => new TextEncoder().encode(m).length !== m.length);

    assert.ok(multiByte.length > 0, 'no displayedMedia in the fixture is multi-byte');
    assert.ok(
      multiByte.some((m) => [...m].length !== m.length),
      'no displayedMedia contains a character outside the BMP (a surrogate pair)',
    );
  });

  it('reproduces the hash from the jsonb-shaped body the API actually serves', async () => {
    // The fixture's `body` is the platform WRITER's rendering: compact separators, alphabetical
    // keys. That is not what crosses the wire. The column is Postgres `jsonb`, which re-renders on
    // the way out with a space after every colon and its own key order (by key length, then
    // bytewise). Verified against a real postgres:16 instance, not assumed.
    //
    // This is also the "re-serialised body" case in the flesh, and it must PASS: the content
    // address is taken over canonical bytes, so re-rendering the JSON cannot legitimately change
    // it. A verifier that failed here would reject honest snapshots.
    for (const vector of FIXTURE.snapshot.vectors) {
      assert.equal(await snapshotHash(parseSnapshotBody(asJsonb(vector.body))), vector.snapshotHash);
    }
  });

  it('refuses a snapshot with two entries for one slot', () => {
    // A duplicate leaves the preimage dependent on arrival order — the exact property sorting
    // exists to remove. No legitimate snapshot has one.
    assert.throws(
      () =>
        snapshotBytes({
          editionFingerprint: 'ab'.repeat(32),
          slots: [
            { slotIndex: 0, currentItemId: '11111111-1111-1111-1111-111111111111', displayedValueCents: 1n, displayedMedia: 'a' },
            { slotIndex: 0, currentItemId: '22222222-2222-2222-2222-222222222222', displayedValueCents: 2n, displayedMedia: 'b' },
          ],
        }),
      /duplicate slotIndex/,
    );
  });

  it('refuses a body whose format_version is not 0x03', () => {
    assert.throws(
      () => parseSnapshotBody({ edition_fingerprint: 'ab'.repeat(32), format_version: 2, slots: [] }),
      /unsupported snapshot format_version/,
    );
  });
});

describe('verify() end to end', () => {
  /** The pinned golden edition every end-to-end case draws against. */
  function canonicalEditionVector() {
    return FIXTURE.editionFingerprint.vectors.find(
      (v: { id: string }) => v.id === 'canonical-unsorted-slots',
    );
  }

  /** The §7 seed and nonce 1, drawn against the pinned golden edition. */
  async function input(overrides: Record<string, unknown> = {}) {
    const vector = canonicalEditionVector();
    const edition = parseEdition({ ...vector.edition, slots: vector.edition.slotsAsGiven });
    // `expected` is merged field-by-field and applied LAST: spreading `overrides` wholesale would
    // replace the entire expected block, so a test overriding one claim would silently blank the
    // other three and pass for the wrong reason.
    return {
      serverSeedHex: FIXTURE.draw.serverSeedHex,
      commitmentHex: FIXTURE.draw.commitmentHex,
      clientSeed: 'alice-seed',
      nonce: 1,
      edition,
      ...overrides,
      expected: {
        editionFingerprint: vector.editionFingerprint,
        drawnPpmValue: 186_669,
        drawnSlotIndex: slotFor(186_669, edition.slots),
        ...(overrides.expected as object | undefined),
      },
    };
  }

  /** The snapshot vector built over the same canonical edition, and the item in the drawn slot. */
  function snapshotVector() {
    return FIXTURE.snapshot.vectors.find(
      (v: { id: string }) => v.id === 'chains-onto-canonical-edition',
    );
  }

  /** {@link input}, plus the published prize-table snapshot so the item is verified too. */
  async function inputWithSnapshot(overrides: Record<string, unknown> = {}) {
    const vector = snapshotVector();
    const base = await input();
    const snapshot = parseSnapshot({
      editionFingerprint: vector.editionFingerprint,
      slots: vector.slotsAsGiven,
    });
    const itemId = vector.slotsAsGiven.find(
      (s: { slotIndex: number }) => s.slotIndex === base.expected.drawnSlotIndex,
    ).currentItemId;

    return {
      ...base,
      snapshot,
      ...overrides,
      expected: {
        ...base.expected,
        snapshotHash: vector.snapshotHash,
        itemId,
        ...(overrides.expected as object | undefined),
      },
    };
  }

  it('passes with a full trace when every claim holds', async () => {
    const report = await verify(await input());

    assert.equal(report.ok, true);
    assert.equal(report.checks.commitment?.ok, true);
    assert.equal(report.checks.editionFingerprint?.ok, true);
    assert.equal(report.checks.drawnPpmValue?.ok, true);
    assert.equal(report.checks.drawnSlotIndex?.ok, true);

    assert.equal(report.trace.message, 'alice-seed:1:0');
    assert.equal(report.trace.hmacHex, FIXTURE.draw.vectors[0].hmacHex);
    assert.equal(report.trace.value, 186_669);
    assert.equal(report.trace.computedEditionFingerprint, report.checks.editionFingerprint?.expected);
    assert.match(report.summary, /^Verified:/);
  });

  it('fails when the commitment does not match the revealed seed', async () => {
    const report = await verify(await input({ commitmentHex: 'ab'.repeat(32) }));

    assert.equal(report.ok, false);
    assert.equal(report.checks.commitment?.ok, false);
    assert.match(report.summary, /^FAILED: commitment/);
  });

  it('fails when the published odds do not match the recorded fingerprint', async () => {
    // The attack this whole library exists to stop: a genuine draw, replayed against a prize table
    // swapped after the fact. Every other check still passes; this one must not.
    const report = await verify(await input({ expected: { editionFingerprint: 'cd'.repeat(32) } }));

    assert.equal(report.ok, false);
    assert.equal(report.checks.editionFingerprint?.ok, false);
    assert.equal(report.checks.commitment?.ok, true);
    assert.equal(report.checks.drawnPpmValue?.ok, true);
  });

  it('says plainly which item it did NOT verify when no snapshot is supplied', async () => {
    // A verifier that stays quiet about the links it never checked turns an unexamined claim into
    // an apparent proof. `ok: true` here is honest only because the caveat travels with it.
    const report = await verify(await input());

    assert.equal(report.ok, true);
    assert.equal(report.checks.drawnItemId, undefined);
    assert.equal(report.caveats.length, 1);
    assert.match(report.caveats[0], /NOT VERIFIED: which item filled slot/);
    assert.match(report.summary, /item in that slot was NOT verified/);
  });

  it('verifies the item in the drawn slot when the snapshot is supplied', async () => {
    const report = await verify(await inputWithSnapshot());

    assert.equal(report.ok, true);
    assert.equal(report.checks.snapshotHash?.ok, true);
    assert.equal(report.checks.snapshotEditionLink?.ok, true);
    assert.equal(report.checks.drawnItemId?.ok, true);
    assert.deepEqual(report.caveats, []);
    assert.equal(report.trace.computedSnapshotHash, snapshotVector().snapshotHash);
    assert.match(report.summary, /puts item [0-9a-f-]{36} in it\.$/);
  });

  it('fails when the item recorded on the win is not the item in the drawn slot', async () => {
    // THE attack the prize-list check exists to stop: a draw and odds that pass every check, landing on
    // a real slot — and then a different, cheaper prize reported for it. Every check that existed
    // before this story still passes.
    const report = await verify(
      await inputWithSnapshot({ expected: { itemId: '99999999-9999-9999-9999-999999999999' } }),
    );

    assert.equal(report.ok, false);
    assert.equal(report.checks.drawnItemId?.ok, false);
    assert.equal(report.checks.commitment?.ok, true);
    assert.equal(report.checks.editionFingerprint?.ok, true);
    assert.equal(report.checks.drawnPpmValue?.ok, true);
    assert.equal(report.checks.drawnSlotIndex?.ok, true);
    assert.equal(report.checks.snapshotHash?.ok, true);
    assert.match(report.summary, /^FAILED: drawnItemId/);
  });

  it('fails when a displayed value in the snapshot was tampered with', async () => {
    const vector = snapshotVector();
    const tampered = parseSnapshot({
      editionFingerprint: vector.editionFingerprint,
      slots: vector.slotsAsGiven.map((s: Record<string, unknown>, i: number) =>
        i === 0 ? { ...s, displayedValueCents: '1' } : s,
      ),
    });
    const report = await verify(await inputWithSnapshot({ snapshot: tampered }));

    assert.equal(report.ok, false);
    assert.equal(report.checks.snapshotHash?.ok, false);
  });

  it('fails when the snapshot is a valid one belonging to a DIFFERENT edition', async () => {
    // Without the chain check this is the hole: a perfectly well-formed snapshot, hashing exactly
    // to the value recorded against it, describing some other edition's prize table entirely.
    const vector = snapshotVector();
    const foreign = parseSnapshot({
      editionFingerprint: 'ab'.repeat(32),
      slots: vector.slotsAsGiven,
    });
    const report = await verify(
      await inputWithSnapshot({
        snapshot: foreign,
        expected: { snapshotHash: await snapshotHash(foreign) },
      }),
    );

    assert.equal(report.ok, false);
    assert.equal(report.checks.snapshotEditionLink?.ok, false);
    assert.equal(report.checks.snapshotHash?.ok, true, 'the foreign snapshot hashes correctly — that is the point');
  });

  it('checks the snapshot but does not pretend about the item when no item id is supplied', async () => {
    // A lookup by win id alone fetches the published snapshot but has no item to compare. That is an
    // honest input, so it must not fail — and it must not pass the item either. The key is REMOVED,
    // not set to undefined: `exactOptionalPropertyTypes` makes those two different types, and it is
    // the absent-key case a real caller produces.
    const base = await inputWithSnapshot();
    const { itemId: _omitted, ...expectedWithoutItem } = base.expected;
    const report = await verify({ ...base, expected: expectedWithoutItem });

    assert.equal(report.status, 'verified');
    assert.equal(report.ok, true);
    assert.equal(report.checks.snapshotHash?.ok, true);
    assert.equal(report.checks.snapshotEditionLink?.ok, true);
    assert.equal(report.checks.drawnItemId, undefined);
    assert.deepEqual(report.notRun.map((n) => n.check), ['drawnItemId']);
    assert.equal(report.trace.itemIdInDrawnSlot, base.expected.itemId);
    assert.equal(report.caveats.length, 1);
    assert.match(report.caveats[0], /NOT VERIFIED: the item recorded for this win/);
    assert.match(report.summary, /NOT compared/);
  });

  it('still catches a tampered snapshot when no item id is supplied', async () => {
    // "Not checked" for the item must never hide a broken prize table.
    const vector = snapshotVector();
    const tampered = parseSnapshot({
      editionFingerprint: vector.editionFingerprint,
      slots: vector.slotsAsGiven.map((s: Record<string, unknown>, i: number) =>
        i === 0 ? { ...s, displayedValueCents: '1' } : s,
      ),
    });
    const base = await inputWithSnapshot({ snapshot: tampered });
    const { itemId: _omitted, ...expectedWithoutItem } = base.expected;
    const report = await verify({ ...base, expected: expectedWithoutItem });

    assert.equal(report.status, 'failed');
    assert.equal(report.checks.snapshotHash?.ok, false);
    assert.equal(report.firstFailure?.check, 'snapshotHash');
    assert.equal(report.firstFailure?.step, 4);
  });

  it('fails, rather than throws, when a snapshot arrives without the hash recorded on the win', async () => {
    const base = await inputWithSnapshot();
    const { snapshotHash: _omitted, ...expectedWithoutHash } = base.expected;
    const report = await verify({ ...base, expected: expectedWithoutHash });

    assert.equal(report.status, 'failed');
    assert.equal(report.checks.snapshotHash?.ok, false);
    assert.equal(report.checks.snapshotHash?.field, 'expected.snapshotHash');
  });

  it('lists every check that did not run, with a reason, when no snapshot is supplied', async () => {
    const report = await verify(await input());

    assert.equal(report.status, 'verified');
    assert.deepEqual(
      report.notRun.map((n) => n.check),
      ['snapshotHash', 'snapshotEditionLink', 'drawnItemId'],
    );
    assert.ok(report.notRun.every((n) => n.reason.length > 0));
  });

  it('traces the cumulative table a reader can check by hand', async () => {
    // The golden edition: slots 0 and 1 hold 25% each, slot 2 holds 50%.
    const report = await verify(await input());

    assert.deepEqual(report.trace.cumulative, [
      { slotIndex: 0, probabilityPpm: 250_000, from: 0, to: 250_000 },
      { slotIndex: 1, probabilityPpm: 250_000, from: 250_000, to: 500_000 },
      { slotIndex: 2, probabilityPpm: 500_000, from: 500_000, to: 1_000_000 },
    ]);
    const row = report.trace.cumulative?.find((r) => r.slotIndex === report.trace.computedSlotIndex);
    assert.ok(row && row.from <= 186_669 && 186_669 < row.to, 'the drawn value lies in the drawn row');
  });

  it('traces all eight chunks of an accepted first chunk', async () => {
    const report = await verify(await input());
    const hmac = bytesFromHex(FIXTURE.draw.vectors[0].hmacHex);

    assert.deepEqual(
      report.trace.chunks,
      CHUNK_OFFSETS.map((offset, i) => ({
        attempt: 0,
        offset,
        chunk: bigEndianUint32(hmac, offset),
        verdict: i === 0 ? 'accepted' : 'not-reached',
      })),
    );
  });

  for (const vector of FIXTURE.draw.vectors.filter((v: { rejected: unknown[] }) => v.rejected.length > 0)) {
    it(`traces rejected, accepted and unread chunks for ${vector.id}`, async () => {
      const derivation = await derive(SERVER_SEED, vector.clientSeed, vector.nonce);
      const hmac = bytesFromHex(vector.hmacHex);
      const expected = CHUNK_OFFSETS.map((offset) => ({
        attempt: vector.attempt,
        offset,
        chunk: bigEndianUint32(hmac, offset),
        verdict: offset < vector.offset ? 'rejected' : offset === vector.offset ? 'accepted' : 'not-reached',
      }));

      assert.deepEqual(derivation.chunks, expected);
      // The rejected entries are the fixture's own rejected list, verdict for verdict.
      assert.deepEqual(
        derivation.chunks.filter((c) => c.verdict === 'rejected').map(({ verdict: _v, ...c }) => c),
        vector.rejected,
      );
    });
  }

  it('fails at step 2, and keeps steps 1 and 3, when the chances do not add up', async () => {
    // One ppm value changed from 250000 to 250001: the table now sums to 1,000,001. That used to
    // throw before any check existed; it is a broken claim about the odds, so it fails step 2.
    const vector = canonicalEditionVector();
    const broken = parseEdition({
      ...vector.edition,
      slots: vector.edition.slotsAsGiven.map((s: { slotIndex: number }) =>
        s.slotIndex === 0 ? { ...s, probabilityPpm: 250_001 } : s,
      ),
    });
    const report = await verify(await input({ edition: broken }));

    assert.equal(report.status, 'failed');
    assert.equal(report.ok, false);
    assert.equal(report.checks.editionFingerprint?.ok, false);
    assert.equal(report.checks.editionFingerprint?.field, 'edition');
    assert.match(report.checks.editionFingerprint?.error ?? '', /must sum to 1000000, was 1000001/);
    assert.deepEqual(
      { check: report.firstFailure?.check, step: report.firstFailure?.step, field: report.firstFailure?.field },
      { check: 'editionFingerprint', step: 2, field: 'edition' },
    );
    assert.equal(report.checks.commitment?.ok, true);
    assert.equal(report.checks.drawnPpmValue?.ok, true);
    assert.ok(report.notRun.some((n) => n.check === 'drawnSlotIndex'));
    assert.equal(report.trace.cumulative, undefined);
  });

  it('fails at step 1 when the revealed seed is not 32 bytes', async () => {
    const report = await verify(await input({ serverSeedHex: FIXTURE.draw.serverSeedHex.slice(0, 62) }));

    assert.equal(report.status, 'failed');
    assert.equal(report.checks.commitment?.ok, false);
    assert.equal(report.checks.commitment?.field, 'serverSeedHex');
    assert.equal(report.firstFailure?.step, 1);
    assert.equal(report.checks.editionFingerprint?.ok, true);
    assert.ok(report.notRun.some((n) => n.check === 'drawnPpmValue'));
  });

  for (const [field, overrides] of [
    ['clientSeed', { clientSeed: 'alice seed' }],
    ['nonce', { nonce: 0 }],
  ] as const) {
    it(`fails at step 3, naming ${field}, when ${field} is not a value the engine accepts`, async () => {
      const report = await verify(await input(overrides));

      assert.equal(report.status, 'failed');
      assert.equal(report.checks.commitment?.ok, true);
      assert.equal(report.checks.drawnPpmValue?.ok, false);
      assert.equal(report.checks.drawnPpmValue?.field, field);
      assert.equal(report.firstFailure?.step, 3);
    });
  }

  it('is pending, not failed and not passed, while the seed is not revealed', async () => {
    const report = await verify(await input({ serverSeedHex: null }));

    assert.equal(report.status, 'pending');
    assert.equal(report.ok, false);
    assert.equal(report.firstFailure, undefined);
    assert.equal(report.checks.editionFingerprint?.ok, true, 'the odds are checked before the reveal');
    assert.equal(report.checks.commitment, undefined);
    assert.deepEqual(
      report.notRun.filter((n) => /not been revealed/.test(n.reason)).map((n) => n.check),
      ['commitment', 'drawnPpmValue', 'drawnSlotIndex'],
    );
    assert.ok(report.caveats.some((c) => /NOT VERIFIED: the draw/.test(c)));
    assert.match(report.summary, /^PENDING:/);
  });

  it('checks the snapshot of a pending open, and leaves its item for later', async () => {
    const report = await verify(await inputWithSnapshot({ serverSeedHex: null }));

    assert.equal(report.status, 'pending');
    assert.equal(report.checks.snapshotHash?.ok, true);
    assert.equal(report.checks.snapshotEditionLink?.ok, true);
    assert.equal(report.checks.drawnItemId, undefined);
    assert.ok(report.notRun.some((n) => n.check === 'drawnItemId' && /not been revealed/.test(n.reason)));
  });

  it('fails, rather than stays pending, when the odds do not match and the seed is not revealed', async () => {
    // A check that ran and failed fails the open, whatever is still pending: odds that do not match
    // their fingerprint cannot be rescued by any seed revealed later.
    // Chances moved between two slots: the sum is still 1,000,000, so only the fingerprint can see it.
    const vector = canonicalEditionVector();
    const swapped = parseEdition({
      ...vector.edition,
      slots: vector.edition.slotsAsGiven.map((s: { slotIndex: number }) =>
        s.slotIndex === 0 ? { ...s, probabilityPpm: 240_000 } : s.slotIndex === 1 ? { ...s, probabilityPpm: 260_000 } : s,
      ),
    });
    const report = await verify(await input({ serverSeedHex: null, edition: swapped }));

    assert.equal(report.status, 'failed');
    assert.equal(report.ok, false);
    assert.equal(report.checks.editionFingerprint?.ok, false);
    assert.equal(report.firstFailure?.check, 'editionFingerprint');
    assert.equal(report.firstFailure?.step, 2);
    assert.match(report.summary, /^FAILED: editionFingerprint did not match/);
    // The checks that need the seed are still reported as not run, with the reason.
    assert.deepEqual(
      report.notRun.filter((n) => /not been revealed/.test(n.reason)).map((n) => n.check),
      ['commitment', 'drawnPpmValue', 'drawnSlotIndex'],
    );
  });

  it('fails, rather than stays pending, when the prize list does not match its hash', async () => {
    const good = await inputWithSnapshot({ serverSeedHex: null });
    const snapshot = { ...good.snapshot, slots: good.snapshot.slots.map((s, i) => (i === 0 ? { ...s, displayedValueCents: s.displayedValueCents + 1n } : s)) };
    const report = await verify({ ...good, snapshot });

    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'snapshotHash');
    assert.equal(report.checks.snapshotEditionLink?.ok, true);
    assert.ok(report.notRun.some((n) => n.check === 'commitment' && /not been revealed/.test(n.reason)));
  });

  it('fails, rather than stays pending, when the prize list belongs to another edition', async () => {
    const good = await inputWithSnapshot({ serverSeedHex: null });
    const foreign = { ...good.snapshot, editionFingerprint: 'ab'.repeat(32) };
    const report = await verify({ ...good, snapshot: foreign, expected: { ...good.expected, snapshotHash: await snapshotHash(foreign) } });

    assert.equal(report.checks.snapshotHash?.ok, true);
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'snapshotEditionLink');
  });

  it('fails a pending open whose commitment can never match: not 64 hex characters', async () => {
    const report = await verify(await input({ serverSeedHex: null, commitmentHex: 'not hex' }));

    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'commitment');
    assert.equal(report.firstFailure?.field, 'commitmentHex');
  });

  it('names the earliest step when several checks fail', async () => {
    // A different seed breaks the commitment (step 1) and, through it, the drawn value (step 3).
    const report = await verify(await input({ serverSeedHex: 'ab'.repeat(32) }));

    assert.equal(report.checks.commitment?.ok, false);
    assert.equal(report.checks.drawnPpmValue?.ok, false);
    assert.equal(report.firstFailure?.check, 'commitment');
    assert.equal(report.firstFailure?.step, 1);
  });

  it('looks the item up in the slot the maths chose, not the slot that was claimed', async () => {
    const good = await inputWithSnapshot();
    const report = await verify({ ...good, expected: { ...good.expected, drawnSlotIndex: 2 } });
    const computedSlot = report.trace.computedSlotIndex;

    assert.notEqual(computedSlot, 2);
    assert.equal(
      report.trace.itemIdInDrawnSlot,
      good.snapshot.slots.find((s) => s.slotIndex === computedSlot)?.currentItemId.toLowerCase(),
    );
  });

  it('compares items as the bytes the hash covers: an id without hyphens is the same item', async () => {
    const good = await inputWithSnapshot();
    const bare = { ...good.snapshot, slots: good.snapshot.slots.map((s) => ({ ...s, currentItemId: s.currentItemId.replace(/-/g, '') })) };
    assert.equal(await snapshotHash(bare), good.expected.snapshotHash);
    const report = await verify({ ...good, snapshot: bare });

    assert.equal(report.status, 'verified');
    assert.equal(report.checks.drawnItemId?.ok, true);
  });

  /** The canonical snapshot with the drawn slot left out, and the hash of that shorter list. */
  async function withoutDrawnSlot(overrides: Record<string, unknown> = {}) {
    const good = await inputWithSnapshot(overrides);
    const drawn = good.expected.drawnSlotIndex;
    const shorter = { ...good.snapshot, slots: good.snapshot.slots.filter((s) => s.slotIndex !== drawn) };
    return { ...good, snapshot: shorter, expected: { ...good.expected, snapshotHash: await snapshotHash(shorter) } };
  }

  // A server drops the slot you won from the prize list and records the hash of the shorter list.
  // Both hashes then agree, so only the slot rules below can see it.
  for (const [what, itemId] of [
    ['no item id', undefined],
    ['the item id of the drawn slot', 'canonical'],
    ['an item id equal to the old stand-in text', '(no such slot in the published snapshot)'],
  ] as const) {
    it(`fails a prize list with no entry for the drawn slot, with ${what}`, async () => {
      const input = await withoutDrawnSlot();
      const expected = { ...input.expected } as Record<string, unknown>;
      if (itemId === undefined) delete expected.itemId;
      else if (itemId !== 'canonical') expected.itemId = itemId;
      const report = await verify({ ...input, expected } as typeof input);

      assert.equal(report.checks.snapshotHash?.ok, true);
      assert.equal(report.status, 'failed');
      assert.equal(report.checks.snapshotEditionLink?.ok, false);
      // A mismatch of slot lists, compared and shown: not an input that could not be used.
      assert.equal(report.checks.snapshotEditionLink?.error, undefined);
      assert.equal(report.checks.snapshotEditionLink?.expected, '0,1,2');
      assert.equal(report.checks.snapshotEditionLink?.computed, [0, 1, 2].filter((i) => i !== input.expected.drawnSlotIndex).join(','));
      assert.equal(report.checks.drawnItemId?.ok, false);
      assert.equal(report.checks.drawnItemId?.error, `the prize list has no entry for slot ${input.expected.drawnSlotIndex}`);
      assert.equal(report.trace.itemIdInDrawnSlot, undefined);
    });
  }

  it('fails a prize list that lists a slot the box does not have', async () => {
    const good = await inputWithSnapshot();
    const extra = { ...good.snapshot, slots: [...good.snapshot.slots, { ...good.snapshot.slots[0], slotIndex: 9 }] };
    const report = await verify({ ...good, snapshot: extra, expected: { ...good.expected, snapshotHash: await snapshotHash(extra) } });

    assert.equal(report.checks.snapshotHash?.ok, true);
    assert.equal(report.firstFailure?.check, 'snapshotEditionLink');
    assert.equal(report.firstFailure?.field, undefined);
    assert.equal(report.firstFailure?.message, 'expected 0,1,2, computed 0,1,2,9');
    assert.equal(report.checks.drawnItemId?.ok, true);
  });

  it('reads broken JSON in a snapshot body as "not valid JSON", not as a wrong type', async () => {
    const base = await input();
    const report = await verifyFrom(() => ({ ...base, snapshot: parseSnapshotBody('{"slots": [') }));

    assert.equal(report.status, 'invalid');
    assert.equal(report.invalid?.message, 'the input could not be read: it is not valid JSON');
    assert.ok(report.invalid?.detail);
  });

  it('treats a null snapshot hash like an absent one: the prize-list step fails by name', async () => {
    const good = await inputWithSnapshot();
    const report = await verify({ ...good, expected: { ...good.expected, snapshotHash: null as unknown as string } });

    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'snapshotHash');
    assert.equal(report.firstFailure?.field, 'expected.snapshotHash');
  });

  it('answers, and never throws, for input nested 20,000 levels deep', async () => {
    const base = await inputWithSnapshot();
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    const reports = [
      // The deep value where the slots should be.
      await verifyFrom(() => ({ ...base, snapshot: parseSnapshotBody(`{"slots":${deep}}`) })),
      // A deep object handed to verify() directly.
      await verify({ ...base, expected: { ...base.expected, itemId: JSON.parse(deep) } }),
    ];
    // Both inputs are broken, so neither may pass; what matters is that each one gets an answer.
    for (const report of reports) assert.ok(['failed', 'invalid'].includes(report.status), report.status);
  });

  it('refuses a missing seed as invalid, by name: only null means "not revealed yet"', async () => {
    const base = await input();
    const report = await verify({ ...base, serverSeedHex: undefined as unknown as string });

    assert.equal(report.status, 'invalid');
    assert.match(report.invalid?.message ?? '', /^serverSeedHex /);
  });

  for (const [what, broken] of [
    ['commitmentHex', { commitmentHex: undefined }],
    ['expected.itemId', { expected: { itemId: null } }],
    ['snapshot.slots', { snapshot: { editionFingerprint: 'ab'.repeat(32), slots: {} } }],
  ] as const) {
    it(`names ${what} when it is missing or of the wrong type, in plain words`, async () => {
      const report = await verify((await inputWithSnapshot(broken as Record<string, unknown>)) as never);

      assert.equal(report.status, 'invalid');
      assert.equal(report.invalid?.message, `${what} is missing or has the wrong type`);
      assert.equal(report.invalid?.detail, undefined);
    });
  }

  it('keeps a runtime error out of the message, in invalid.detail only', async () => {
    const report = await verifyFrom(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    });

    assert.equal(report.status, 'invalid');
    assert.doesNotMatch(report.invalid?.message ?? '', /Cannot read properties/);
    assert.match(report.invalid?.detail ?? '', /Cannot read properties/);
  });

  it('reports an input it cannot read as invalid instead of throwing', async () => {
    const base = await input();
    // No `expected` block at all: there is nothing to check against, so no step can be named.
    const report = await verify({ ...base, expected: undefined as unknown as typeof base.expected });

    assert.equal(report.status, 'invalid');
    assert.equal(report.ok, false);
    assert.ok(report.invalid?.message);
    assert.match(report.summary, /^CANNOT CHECK:/);
    assert.equal(report.notRun.length, 7);
  });

  it('turns a refusal while parsing into an invalid report', async () => {
    const base = await input();
    const report = await verifyFrom(() => ({ ...base, edition: parseEdition({ slots: {} }) }));

    assert.equal(report.status, 'invalid');
    assert.equal(report.ok, false);
    assert.equal(report.invalid?.message, 'edition.slots must be an array');
  });
});

/**
 * The upgrade families (`upgradeStep`, `upgradeOffer`, KAN-1154 A2), reproduced from their own
 * sections alone. Every value a step vector states is recomputed from its inputs, the drawn `v`
 * included, so no vector can pass by reading its own answer back. rng-fairness §4b.
 */
const STEP = FIXTURE.upgradeStep;
const OFFER = FIXTURE.upgradeOffer;

interface StepVector {
  id: string;
  clientSeed: string;
  nonce: number;
  stakedBuyBackValueCents: number;
  targetBuyBackValueCents: number;
  chancePpm: number;
  chanceCompact: string;
  stepTablePpm: number[];
  v: number;
  slotIndex: number;
  outcome: 'won' | 'lost';
}

interface OfferQuery {
  heldSlotIndex: number;
  stepNo: number;
  targetSlotIndex?: number;
  chancePpm?: number;
  noOfferReason?: string;
}

interface OfferVector {
  id: string;
  engineType: string;
  slotsAsGiven: { slotIndex: number; buyBackValueCents: number }[];
  queries: OfferQuery[];
}

/** The offer for one query, with the reason when there is none, built from this library's parts. */
function offerFor(vector: OfferVector, query: OfferQuery): OfferQuery {
  const base = { heldSlotIndex: query.heldSlotIndex, stepNo: query.stepNo };
  if (vector.engineType !== UPGRADE_ENGINE_TYPE) return { ...base, noOfferReason: 'not_upgrade_engine' };
  if (query.stepNo >= UPGRADE_MAX_STEPS) return { ...base, noOfferReason: 'cap_reached' };
  // Only the buy-back values take part in an offer; the other slot fields are not in these vectors.
  // The odds must still be a valid table, so the whole million sits on the first slot as given.
  const slots: SlotOdds[] = vector.slotsAsGiven.map((slot, i) => ({
    slotIndex: slot.slotIndex,
    probabilityPpm: i === 0 ? PPM_TOTAL : 0,
    requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
    requiredMarketValueCents: 0n,
  }));
  const offer = upgradeTarget({ slots }, query.heldSlotIndex);
  if (offer !== null) return { ...base, targetSlotIndex: offer.targetSlotIndex, chancePpm: offer.chancePpm };
  const held = slots.find((slot) => slot.slotIndex === query.heldSlotIndex)!;
  const higher = slots.some((slot) => slot.requiredBuyBackValueCents > held.requiredBuyBackValueCents);
  return { ...base, noOfferReason: higher ? 'under_minimum' : 'top_value' };
}

describe('the upgrade sections of the fixture', () => {
  it('state the constants this library uses', () => {
    for (const section of [STEP, OFFER]) {
      assert.equal(section.constants.engineType, UPGRADE_ENGINE_TYPE);
      assert.equal(section.constants.maxSteps, UPGRADE_MAX_STEPS);
      assert.equal(section.constants.minChancePpm, UPGRADE_MIN_CHANCE_PPM);
      assert.equal(section.constants.engineVersion, UPGRADE_ENGINE_VERSION);
      assert.equal(section.constants.stepRtpBps, UPGRADE_STEP_RTP_BPS);
    }
  });

  it('carry a commitment that is the digest of their own server seed', async () => {
    assert.equal(await commitment(bytesFromHex(STEP.serverSeedHex)), STEP.commitmentHex);
  });

  it('have the step vectors the plan named, and offer vectors for every no-offer reason', () => {
    // Names, not a count: a silently dropped vector shows here by its id.
    assert.deepEqual(
      (STEP.vectors as StepVector[]).map((v) => v.id),
      [
        'boundary-v-equals-p',
        'boundary-v-below-p',
        'worked-12-to-30',
        'worked-5-to-12-remainder',
        'worked-30-to-80',
        'minimum-chance-8-to-80',
      ],
    );
    const reasons = new Set(
      (OFFER.vectors as OfferVector[]).flatMap((v) => v.queries.map((q) => q.noOfferReason)).filter(Boolean),
    );
    assert.deepEqual([...reasons].sort(), ['cap_reached', 'not_upgrade_engine', 'top_value', 'under_minimum']);
  });
});

describe('every upgrade step vector, from its inputs', () => {
  const seed = bytesFromHex(STEP.serverSeedHex);
  for (const vector of STEP.vectors as StepVector[]) {
    it(vector.id, async () => {
      record('upgradeStep', vector.id);
      const chance = upgradeChancePpm(
        BigInt(vector.stakedBuyBackValueCents),
        BigInt(vector.targetBuyBackValueCents),
      );
      assert.equal(chance, vector.chancePpm, 'chance');
      assert.deepEqual(
        stepTable(chance).map((row) => row.probabilityPpm),
        vector.stepTablePpm,
        'step table',
      );
      assert.equal(vector.stepTablePpm[0] + vector.stepTablePpm[1], PPM_TOTAL);

      const v = (await derive(seed, vector.clientSeed, vector.nonce)).value;
      assert.equal(v, vector.v, 'drawn v');
      const outcome = stepOutcome(v, chance);
      assert.equal(outcome, vector.outcome, 'outcome');
      assert.equal(outcome === 'won' ? 0 : 1, vector.slotIndex, 'slot index');
      assert.equal(stepChanceText(chance), vector.chanceCompact, 'chanceCompact');
    });
  }
});

describe('every upgrade offer vector', () => {
  for (const vector of OFFER.vectors as OfferVector[]) {
    it(vector.id, () => {
      record('upgradeOffer', vector.id);
      for (const query of vector.queries) {
        const { chanceCompact: shown, ...expected } = query as OfferQuery & { chanceCompact?: string };
        assert.deepEqual(offerFor(vector, query), expected, `held slot ${query.heldSlotIndex}, step ${query.stepNo}`);
        // The platform's rendered string of an offer is checked against the library's own format too.
        if (expected.chancePpm !== undefined) {
          assert.equal(stepChanceText(expected.chancePpm), shown, `chanceCompact, held slot ${query.heldSlotIndex}, step ${query.stepNo}`);
        } else assert.equal(shown, undefined, `no offer, no chanceCompact: held slot ${query.heldSlotIndex}`);
      }
    });
  }
});

/**
 * The two families of version 2 (KAN-1567, platform PR-1): the list of targets a win may name, and the
 * worst path a box must still pass at its floor. Both are computed here from this library's own
 * `upgradeTargets`, so the target rule is pinned twice: once as a list, once through every payout it
 * leads to. rng-fairness §4b.
 */
const TARGETS = FIXTURE.upgradeTargets;
const WORST = FIXTURE.upgradeWorstPath;
const MILLION = BigInt(PPM_TOTAL);

interface TargetEntry {
  targetSlotIndex: number;
  kind: string;
  chancePpm: number;
  chanceCompact: string;
}

interface TargetsQuery extends OfferQuery {
  chanceCompact?: string;
  targets: TargetEntry[];
}

interface TargetsVector {
  id: string;
  engineType: string;
  engineVersion: number;
  slotsAsGiven: { slotIndex: number; buyBackValueCents: number; kind: string }[];
  queries: TargetsQuery[];
}

interface Fraction {
  numerator: string;
  denominator: string;
}

interface WorstPathVector {
  id: string;
  engineType: string;
  engineVersion: number;
  priceCents: string;
  slots: { slotIndex: number; probabilityPpm: number; buyBackValueCents: number }[];
  worstPathPayoutCents: Fraction;
  worstPathRtp: Fraction;
  worstPathRtpText: string;
  verdicts: { floorBps: number; meetsFloor: boolean }[];
}

/** The list for one query, from this library: none past the cap; the kind is the target slot's own, as given. */
function targetsFor(vector: TargetsVector, query: TargetsQuery): TargetEntry[] {
  if (vector.engineType !== UPGRADE_ENGINE_TYPE || query.stepNo >= UPGRADE_MAX_STEPS) return [];
  // Only the buy-back values take part, so the whole million sits on the first slot as given, as in offerFor.
  const slots: SlotOdds[] = vector.slotsAsGiven.map((slot, i) => ({
    slotIndex: slot.slotIndex,
    probabilityPpm: i === 0 ? PPM_TOTAL : 0,
    requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
    requiredMarketValueCents: 0n,
  }));
  const kinds = new Map(vector.slotsAsGiven.map((slot) => [slot.slotIndex, slot.kind]));
  return upgradeTargets({ slots }, query.heldSlotIndex, vector.engineVersion).map((target) => ({
    targetSlotIndex: target.targetSlotIndex,
    kind: kinds.get(target.targetSlotIndex) as string,
    chancePpm: target.chancePpm,
    chanceCompact: stepChanceText(target.chancePpm),
  }));
}

/**
 * The worst path's payout per open, scaled by 1 000 000^(1 + MAX_STEPS): the player who steps at every
 * chance until the cap and names, at every step, the target that leaves the least. A win at depth d (steps
 * already taken) is worth its value × 1 000 000^(MAX_STEPS − d) when it has no target, else the least of
 * chance × the target's worth at d + 1; both sides carry the same scale, so no division happens before the end.
 */
function worstPathScaled(vector: WorstPathVector): bigint {
  const slots: SlotOdds[] = vector.slots.map((slot) => ({
    slotIndex: slot.slotIndex,
    probabilityPpm: slot.probabilityPpm,
    requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
    requiredMarketValueCents: 0n,
  }));
  let deeper = new Map<number, bigint>();
  for (let depth = UPGRADE_MAX_STEPS; depth >= 0; depth--) {
    const here = new Map<number, bigint>();
    for (const slot of slots) {
      const targets = depth >= UPGRADE_MAX_STEPS ? [] : upgradeTargets({ slots }, slot.slotIndex, vector.engineVersion);
      here.set(
        slot.slotIndex,
        targets.length === 0
          ? slot.requiredBuyBackValueCents * MILLION ** BigInt(UPGRADE_MAX_STEPS - depth)
          : targets
              .map((target) => BigInt(target.chancePpm) * (deeper.get(target.targetSlotIndex) as bigint))
              .reduce((least, payout) => (payout < least ? payout : least)),
      );
    }
    deeper = here;
  }
  return slots.reduce((sum, slot) => sum + BigInt(slot.probabilityPpm) * (deeper.get(slot.slotIndex) as bigint), 0n);
}

function lowestTerms(numerator: bigint, denominator: bigint): Fraction {
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: String(numerator / a), denominator: String(denominator / a) };
}

/** A ratio as a percent floored to 6 decimals: 0.93000362… is "93.000362%". */
function percentFloor6(numerator: bigint, denominator: bigint): string {
  const millionths = (numerator * 100n * 1_000_000n) / denominator;
  return `${millionths / 1_000_000n}.${String(millionths % 1_000_000n).padStart(6, '0')}%`;
}

describe('the version 2 sections of the fixture (KAN-1567)', () => {
  it('state the version table this library uses', () => {
    for (const section of [TARGETS, WORST]) {
      assert.equal(section.constants.engineType, UPGRADE_ENGINE_TYPE);
      // The fixture's version 1 and 2 sections state versions 1 and 2; version 3's families come with the
      // platform's version 3 vectors (KAN-1751 PR-1b2) and state their own constants.
      assert.deepEqual(section.constants.engineVersions, UPGRADE_RULES.filter((rule) => rule.engineVersion <= 2).map((rule) => rule.engineVersion));
      assert.equal(section.constants.maxSteps, UPGRADE_MAX_STEPS);
      assert.equal(section.constants.minChancePpm, upgradeRule(1)?.minChancePpm);
      assert.equal(section.constants.jumpMinChancePpm, upgradeRule(2)?.minChancePpm);
      assert.equal(section.constants.jumpMinChancePpm, UPGRADE_JUMP_MIN_CHANCE_PPM);
      assert.equal(section.constants.stepRtpBps, UPGRADE_STEP_RTP_BPS);
    }
  });

  it('have the vectors platform PR-1 named', () => {
    // Names, not a count: a silently dropped vector shows here by its id.
    assert.deepEqual(
      (TARGETS.vectors as TargetsVector[]).map((v) => v.id),
      ['worked-box-v2', 'worked-box-v1', 'jump-minimum-edges', 'ties-list-each-slot', 'wallet-credit-target', 'cap'],
    );
    assert.deepEqual(
      (WORST.vectors as WorstPathVector[]).map((v) => v.id),
      [
        'worked-box-v1',
        'worked-box-v2',
        'exact-93-v1',
        'exact-93-v2',
        'operator-floor-94-v2',
        'climb-passes-worst-fails-v1',
        'climb-passes-worst-fails-v2',
        'depth-greedy-cut-cap-v2',
      ],
    );
  });
});

describe('every upgrade target-list vector', () => {
  for (const vector of TARGETS.vectors as TargetsVector[]) {
    it(vector.id, () => {
      record('upgradeTargets', vector.id);
      for (const query of vector.queries) {
        // The offer is the upgradeOffer rule on every version; the list is the version's own.
        const offer = offerFor(vector, query);
        const computed: TargetsQuery = { ...offer, targets: targetsFor(vector, query) };
        if (offer.chancePpm !== undefined) computed.chanceCompact = stepChanceText(offer.chancePpm);
        assert.deepEqual(computed, query, `held slot ${query.heldSlotIndex}, step ${query.stepNo}`);
      }
    });
  }
});

describe('every upgrade worst-path vector', () => {
  for (const vector of WORST.vectors as WorstPathVector[]) {
    it(vector.id, () => {
      record('upgradeWorstPath', vector.id);
      assert.equal(vector.engineType, UPGRADE_ENGINE_TYPE);
      const scale = MILLION ** BigInt(1 + UPGRADE_MAX_STEPS);
      const price = BigInt(vector.priceCents);
      const worst = worstPathScaled(vector);
      assert.deepEqual(lowestTerms(worst, scale), vector.worstPathPayoutCents, 'worst-path payout');
      assert.deepEqual(lowestTerms(worst, scale * price), vector.worstPathRtp, 'worst-path RTP');
      assert.equal(percentFloor6(worst, scale * price), vector.worstPathRtpText, 'worst-path RTP text');
      // The box returns Σ ppm × value over 1 000 000 × price; it and the worst path must both reach the floor.
      const box = vector.slots.reduce((sum, slot) => sum + BigInt(slot.probabilityPpm) * BigInt(slot.buyBackValueCents), 0n);
      assert.deepEqual(
        vector.verdicts.map(({ floorBps }) => ({
          floorBps,
          meetsFloor:
            box * 10_000n >= BigInt(floorBps) * MILLION * price && worst * 10_000n >= BigInt(floorBps) * scale * price,
        })),
        vector.verdicts,
        'verdicts',
      );
    });
  }
});

/**
 * The third family of version 2 (KAN-1567, platform PR-1b): a step to a target the player named, which
 * version 1 does not allow. Every value is recomputed from the vector's inputs, as for `upgradeStep`, and
 * the named target is checked against version 2's rule: a slot of the box worth strictly more, at the
 * formula's chance, and that chance at least 1 %. Then each step runs through `verifyUpgradeStep`, the
 * check the page calls: verified on a version 2 edition of the vector's slots, failed on the target when
 * the same edition says version 1. rng-fairness §4b.
 */
const JUMP_STEP = FIXTURE.upgradeJumpStep;

interface JumpStepVector extends StepVector {
  slotsAsGiven: { slotIndex: number; buyBackValueCents: number }[];
  heldSlotIndex: number;
  /** The held win's step number, 0 for a box win; the step record carries this + 1. */
  stepNo: number;
  targetSlotIndex: number;
}

/** The vector's slots as an edition's slots: only the buy-back values take part, as in offerFor. */
function jumpSlots(vector: JumpStepVector): SlotOdds[] {
  return vector.slotsAsGiven.map((slot, i) => ({
    slotIndex: slot.slotIndex,
    probabilityPpm: i === 0 ? PPM_TOTAL : 0,
    requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
    requiredMarketValueCents: 0n,
  }));
}

/**
 * The step record of one vector on an edition of its slots at `engineVersion`. The fingerprint is
 * computed here, so the engine id and the price are any fixed values: the check under test is the step's.
 */
async function jumpStepInput(vector: JumpStepVector, engineVersion: number): Promise<UpgradeStepInput> {
  const edition: Edition = {
    engineId: '15671567-0000-4000-8000-000000000002',
    engineVersion,
    priceCents: 2000n,
    slots: jumpSlots(vector),
  };
  return {
    serverSeedHex: JUMP_STEP.serverSeedHex,
    commitmentHex: JUMP_STEP.commitmentHex,
    clientSeed: vector.clientSeed,
    nonce: vector.nonce,
    edition,
    engineType: JUMP_STEP.constants.engineType,
    expected: {
      editionFingerprint: await editionFingerprint(edition),
      stakedSlotIndex: vector.heldSlotIndex,
      targetSlotIndex: vector.targetSlotIndex,
      chancePpm: vector.chancePpm,
      chanceCompact: vector.chanceCompact,
      drawnPpmValue: vector.v,
      outcome: vector.outcome,
      stepNo: vector.stepNo + 1,
    },
  };
}

describe('the jump-step section of the fixture (KAN-1567)', () => {
  it('states version 2 and the constants this library uses for it', () => {
    const c = JUMP_STEP.constants;
    assert.equal(c.engineType, UPGRADE_ENGINE_TYPE);
    assert.equal(c.engineVersion, 2);
    const rule = upgradeRule(c.engineVersion);
    assert.equal(rule?.minChancePpm, c.jumpMinChancePpm);
    assert.equal(rule?.jumps, true);
    assert.equal(rule?.maxSteps, c.maxSteps);
    assert.equal(rule?.stepRtpBps, c.stepRtpBps);
    assert.equal(c.jumpMinChancePpm, UPGRADE_JUMP_MIN_CHANCE_PPM);
    assert.equal(c.minChancePpm, upgradeRule(1)?.minChancePpm);
    assert.equal(c.maxSteps, UPGRADE_MAX_STEPS);
    assert.equal(c.stepRtpBps, UPGRADE_STEP_RTP_BPS);
  });

  it('carries a commitment that is the digest of its own server seed', async () => {
    assert.equal(await commitment(bytesFromHex(JUMP_STEP.serverSeedHex)), JUMP_STEP.commitmentHex);
  });

  it('has the vectors platform PR-1b named', () => {
    // Names, not a count: a silently dropped vector shows here by its id.
    assert.deepEqual(
      (JUMP_STEP.vectors as JumpStepVector[]).map((v) => v.id),
      ['past-next-won', 'past-next-lost', 'jump-minimum-won'],
    );
  });
});

describe('every upgrade jump-step vector, from its inputs', () => {
  const seed = bytesFromHex(JUMP_STEP.serverSeedHex);
  for (const vector of JUMP_STEP.vectors as JumpStepVector[]) {
    it(vector.id, async () => {
      record('upgradeJumpStep', vector.id);
      const slots = jumpSlots(vector);
      const valueOf = (slotIndex: number) => slots.find((slot) => slot.slotIndex === slotIndex)?.requiredBuyBackValueCents;
      assert.equal(valueOf(vector.heldSlotIndex), BigInt(vector.stakedBuyBackValueCents), 'the staked value is the held slot\'s');
      assert.equal(valueOf(vector.targetSlotIndex), BigInt(vector.targetBuyBackValueCents), 'the target value is the named slot\'s');
      assert.ok(vector.stepNo < UPGRADE_MAX_STEPS, 'the held win is under the cap');

      // Version 2's rule for the named slot: worth strictly more, the formula's chance, at least 1 %.
      assert.ok(BigInt(vector.targetBuyBackValueCents) > BigInt(vector.stakedBuyBackValueCents), 'worth strictly more');
      const chance = upgradeChancePpm(BigInt(vector.stakedBuyBackValueCents), BigInt(vector.targetBuyBackValueCents));
      assert.equal(chance, vector.chancePpm, 'chance');
      assert.ok(chance >= UPGRADE_JUMP_MIN_CHANCE_PPM, 'at least 1 %');
      assert.deepEqual(
        upgradeTargets({ slots }, vector.heldSlotIndex, JUMP_STEP.constants.engineVersion).find(
          (target) => target.targetSlotIndex === vector.targetSlotIndex,
        ),
        { targetSlotIndex: vector.targetSlotIndex, chancePpm: vector.chancePpm },
        'a version 2 target of the held slot, at that chance',
      );
      // And a step version 1 does not allow: its single offer is another slot, or none.
      assert.notEqual(upgradeTarget({ slots }, vector.heldSlotIndex)?.targetSlotIndex, vector.targetSlotIndex, 'not version 1\'s offer');

      assert.deepEqual(stepTable(chance).map((row) => row.probabilityPpm), vector.stepTablePpm, 'step table');
      const v = (await derive(seed, vector.clientSeed, vector.nonce)).value;
      assert.equal(v, vector.v, 'drawn v');
      const outcome = stepOutcome(v, chance);
      assert.equal(outcome, vector.outcome, 'outcome');
      assert.equal(outcome === 'won' ? 0 : 1, vector.slotIndex, 'slot index');
      assert.equal(stepChanceText(chance), vector.chanceCompact, 'chanceCompact');
    });
  }
});

describe('every upgrade jump-step vector, through verifyUpgradeStep', () => {
  for (const vector of JUMP_STEP.vectors as JumpStepVector[]) {
    it(`${vector.id}: verified on version 2, failed on the target on version 1`, async () => {
      const report = await verifyUpgradeStep(await jumpStepInput(vector, 2));
      assert.equal(report.status, 'verified', report.summary);
      assert.deepEqual(report.notRun, []);
      assert.deepEqual(report.trace.computedOffer, { targetSlotIndex: vector.targetSlotIndex, chancePpm: vector.chancePpm });
      assert.equal(report.trace.computedOutcome, vector.outcome);

      const onVersion1 = await verifyUpgradeStep(await jumpStepInput(vector, 1));
      assert.equal(onVersion1.status, 'failed');
      assert.equal(onVersion1.firstFailure?.check, 'upgradeTarget');
      assert.equal(onVersion1.checks.editionFingerprint?.ok, true);
    });
  }
});

const RATE_STEP = FIXTURE.upgradeRateStep;

interface RateTarget {
  targetSlotIndex: number;
  chancePpm: number;
  chanceCompact: string;
}

interface RateQuery {
  heldSlotIndex: number;
  /** The held win's step number, 0 for a box win. */
  stepNo: number;
  targets: RateTarget[];
  offer?: RateTarget;
  noOfferReason?: 'top_value' | 'under_minimum';
}

interface RateStepVector extends JumpStepVector {
  stakedBuyBackValueCents: number;
}

/** A family that is a box: its slots and price, and the three numbers written about its return. */
interface BoxFamily {
  id: string;
  note: string;
  priceCents: string;
  slots: { slotIndex: number; probabilityPpm: number; buyBackValueCents: number }[];
  /** S, the sum over the slots of chance in ppm times buy-back cents, as a decimal string. Compared, never read. */
  payoutTimesMillion: string;
  /** The box's return in basis points before the cap and the floor. Compared, never read. */
  boxBps: number;
  /** The family's rate, written for the reader. Never read for a chance: see checkRateFamily. */
  stepRtpBps: number;
}

interface RateFamily extends BoxFamily {
  queries: RateQuery[];
  steps: RateStepVector[];
}

/** A family's box as an edition: its own chances, buy-back values and price, so its rate is its own. */
function rateEdition(family: BoxFamily, engineVersion = 3): Edition {
  return {
    engineId: '17511751-0000-4000-8000-000000000003',
    engineVersion,
    priceCents: BigInt(family.priceCents),
    slots: family.slots.map((slot) => ({
      slotIndex: slot.slotIndex,
      probabilityPpm: slot.probabilityPpm,
      requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
      requiredMarketValueCents: 0n,
    })),
  };
}

/**
 * The library's rate for a family's box, computed from the box, and the family refused when its written
 * rate differs. The oracle on platform refuses the same family (tools/oracle/upgrade_rate.py): the written
 * number is for the reader, and a family whose number and box disagree is a broken family, not a pass.
 * Refs: KAN-1751 plan v2.4 S-7
 */
function checkRateFamily(family: BoxFamily, constants: { engineVersion: number; stepRtpCapBps: number } = RATE_STEP.constants): number {
  // S and boxBps are worked out here from the box, in BigInt (S can pass 2^53 on a large box), and the
  // library's rate must be boxBps under the cap: the three written numbers are each compared, none is read.
  const sum = family.slots.reduce((acc, slot) => acc + BigInt(slot.probabilityPpm) * BigInt(slot.buyBackValueCents), 0n);
  if (typeof family.payoutTimesMillion !== 'string' || BigInt(family.payoutTimesMillion) !== sum) {
    throw new Error(`family ${family.id} writes S = ${family.payoutTimesMillion}, its box gives ${sum}`);
  }
  const boxBps = (10_000n * sum) / (BigInt(PPM_TOTAL) * BigInt(family.priceCents));
  if (BigInt(family.boxBps) !== boxBps) {
    throw new Error(`family ${family.id} writes boxBps ${family.boxBps}, its box gives ${boxBps}`);
  }
  const rate = upgradeStepRateBps(rateEdition(family, constants.engineVersion), constants.engineVersion);
  if (rate !== family.stepRtpBps) {
    throw new Error(`family ${family.id} writes a rate of ${family.stepRtpBps} bps, its box gives ${rate}`);
  }
  if (BigInt(rate) !== (boxBps < BigInt(constants.stepRtpCapBps) ? boxBps : BigInt(constants.stepRtpCapBps))) {
    throw new Error(`family ${family.id}: the library's rate ${rate} is not boxBps ${boxBps} under the cap`);
  }
  return rate;
}

function rateStepInput(
  family: BoxFamily,
  vector: RateStepVector,
  edition: Edition,
  fingerprint: string,
  section: { serverSeedHex: string; commitmentHex: string; constants: { engineType: string } } = RATE_STEP,
): UpgradeStepInput {
  return {
    serverSeedHex: section.serverSeedHex,
    commitmentHex: section.commitmentHex,
    clientSeed: vector.clientSeed,
    nonce: vector.nonce,
    edition,
    engineType: section.constants.engineType,
    expected: {
      editionFingerprint: fingerprint,
      stakedSlotIndex: vector.heldSlotIndex,
      targetSlotIndex: vector.targetSlotIndex,
      chancePpm: vector.chancePpm,
      chanceCompact: vector.chanceCompact,
      drawnPpmValue: vector.v,
      outcome: vector.outcome,
      stepNo: vector.stepNo + 1,
    },
  };
}

const RATE_FAMILIES = RATE_STEP.families as RateFamily[];

describe('the version 3 section of the fixture (KAN-1751)', () => {
  it('states version 3 and the constants this library uses for it', () => {
    const c = RATE_STEP.constants;
    const rule = upgradeRule(3);
    assert.equal(c.engineType, UPGRADE_ENGINE_TYPE);
    assert.equal(c.engineVersion, rule?.engineVersion);
    assert.equal(c.maxSteps, rule?.maxSteps);
    assert.equal(c.minChancePpm, rule?.minChancePpm);
    assert.equal(c.offerMinChancePpm, rule?.offerMinChancePpm);
    assert.equal(c.stepRtpCapBps, rule?.stepRtpCapBps);
    assert.equal(c.stepRtpFloorBps, rule?.stepRtpFloorBps);
    assert.equal(rule?.roundsUp, true);
    assert.equal(rule?.jumps, true);
  });

  it('carries a commitment that is the digest of its own server seed', async () => {
    assert.equal(await commitment(bytesFromHex(RATE_STEP.serverSeedHex)), RATE_STEP.commitmentHex);
  });

  it('has the families platform PR-1b2 named', () => {
    assert.deepEqual(
      RATE_FAMILIES.map((family) => family.id),
      [
        'rate-9300',
        'rate-9300-single-offer-8-to-80',
        'rate-9300-single-offer-5-to-80',
        'rate-9300-single-offer-edge',
        'rate-9300-single-offer-under-minimum',
        'rate-pin-worked-box',
        'rate-9400',
        'rate-9550',
        'rate-9636',
        'rate-9636-minimum-target',
        'rate-9990-above-cap',
        'rate-9990-at-cap',
        'rate-9500-equal-values',
      ],
    );
  });

  it('refuses a family whose written rate, S or boxBps is one off its box, either way', () => {
    // S-7: the rate comes from the box. A family copied with a field moved by one must be refused;
    // were the field read, the copy would pass.
    for (const family of RATE_FAMILIES) {
      for (const delta of [-1, 1]) {
        const rate = { ...family, stepRtpBps: family.stepRtpBps + delta };
        assert.throws(() => checkRateFamily(rate), new RegExp(`family ${family.id} writes a rate of ${rate.stepRtpBps} bps`));
        const s = { ...family, payoutTimesMillion: String(BigInt(family.payoutTimesMillion) + BigInt(delta)) };
        assert.throws(() => checkRateFamily(s), new RegExp(`family ${family.id} writes S = ${s.payoutTimesMillion},`));
        const box = { ...family, boxBps: family.boxBps + delta };
        assert.throws(() => checkRateFamily(box), new RegExp(`family ${family.id} writes boxBps ${box.boxBps},`));
      }
      // S is a decimal string, as the price is: a number in its place is refused, not read.
      assert.throws(() => checkRateFamily({ ...family, payoutTimesMillion: Number(family.payoutTimesMillion) as unknown as string }), /writes S/);
    }
  });

  it('has a family with a rate above the cap, so boxBps and the rate differ somewhere', () => {
    assert.ok(RATE_FAMILIES.some((family) => family.boxBps > family.stepRtpBps));
  });
});

describe('every version 3 family, from its box', () => {
  for (const family of RATE_FAMILIES) {
    it(family.id, () => {
      record('upgradeRateStep', family.id);
      const rate = checkRateFamily(family);
      const edition = rateEdition(family);
      family.queries.forEach((query, i) => {
        record('upgradeRateStep', `${family.id}/query-${i}`);
        const where = `query ${i} (held slot ${query.heldSlotIndex})`;
        const targets = upgradeTargets(edition, query.heldSlotIndex, 3);
        assert.deepEqual(
          targets,
          query.targets.map(({ targetSlotIndex, chancePpm }) => ({ targetSlotIndex, chancePpm })),
          `${where}: targets`,
        );
        for (const target of query.targets) {
          assert.equal(stepChanceText(target.chancePpm), target.chanceCompact, `${where}: chanceCompact of slot ${target.targetSlotIndex}`);
        }
        const offer = upgradeTarget(edition, query.heldSlotIndex, 3);
        if (query.offer === undefined) {
          assert.equal(offer, null, `${where}: no offer`);
          const held = edition.slots.find((slot) => slot.slotIndex === query.heldSlotIndex)!.requiredBuyBackValueCents;
          const higher = edition.slots.filter((slot) => slot.requiredBuyBackValueCents > held);
          if (query.noOfferReason === 'top_value') {
            assert.equal(higher.length, 0, `${where}: top_value means nothing is worth more`);
          } else {
            assert.equal(query.noOfferReason, 'under_minimum', `${where}: a known reason`);
            const next = higher.reduce((a, b) => (b.requiredBuyBackValueCents < a.requiredBuyBackValueCents ? b : a));
            assert.ok(
              upgradeChancePpm(held, next.requiredBuyBackValueCents, rate, true) < RATE_STEP.constants.offerMinChancePpm,
              `${where}: under_minimum means the next value is under the offer's minimum`,
            );
          }
        } else {
          assert.deepEqual(offer, { targetSlotIndex: query.offer.targetSlotIndex, chancePpm: query.offer.chancePpm }, `${where}: offer`);
          // On version 3 the single offer is always the list's first entry.
          assert.deepEqual(offer, targets[0], `${where}: the offer is the first target`);
        }
      });
    });
  }
});

describe('every version 3 step, from its inputs and through verifyUpgradeStep', () => {
  const seed = bytesFromHex(RATE_STEP.serverSeedHex);
  for (const family of RATE_FAMILIES) {
    for (const vector of family.steps) {
      it(`${family.id}/${vector.id}`, async () => {
        record('upgradeRateStep', `${family.id}/${vector.id}`);
        const rate = checkRateFamily(family);
        const edition = rateEdition(family);
        const valueOf = (slotIndex: number) => edition.slots.find((slot) => slot.slotIndex === slotIndex)?.requiredBuyBackValueCents;
        assert.equal(valueOf(vector.heldSlotIndex), BigInt(vector.stakedBuyBackValueCents), "the staked value is the held slot's");
        assert.equal(valueOf(vector.targetSlotIndex), BigInt(vector.targetBuyBackValueCents), "the target value is the named slot's");

        const chance = upgradeChancePpm(BigInt(vector.stakedBuyBackValueCents), BigInt(vector.targetBuyBackValueCents), rate, true);
        assert.equal(chance, vector.chancePpm, 'chance');
        assert.deepEqual(stepTable(chance).map((row) => row.probabilityPpm), vector.stepTablePpm, 'step table');
        const v = (await derive(seed, vector.clientSeed, vector.nonce)).value;
        assert.equal(v, vector.v, 'drawn v');
        const outcome = stepOutcome(v, chance);
        assert.equal(outcome, vector.outcome, 'outcome');
        assert.equal(outcome === 'won' ? 0 : 1, vector.slotIndex, 'slot index');
        assert.equal(stepChanceText(chance), vector.chanceCompact, 'chanceCompact');

        const fingerprint = await editionFingerprint(edition);
        const report = await verifyUpgradeStep(rateStepInput(family, vector, edition, fingerprint));
        assert.equal(report.status, 'verified', report.summary);
        assert.deepEqual(report.notRun, []);
        assert.equal(report.trace.stepRateBps, family.stepRtpBps);
        assert.deepEqual(report.trace.computedOffer, { targetSlotIndex: vector.targetSlotIndex, chancePpm: vector.chancePpm });
        assert.equal(report.trace.computedOutcome, vector.outcome);

        // The same step on a version 2 edition of the same box is not this chance.
        const asVersion2 = rateEdition(family, 2);
        const onVersion2 = await verifyUpgradeStep(rateStepInput(family, vector, asVersion2, await editionFingerprint(asVersion2)));
        assert.equal(onVersion2.status, 'failed', onVersion2.summary);
      });
    }
  }
});

const BOOST_CHANCE = FIXTURE.upgradeBoostChance;
const BOOST_LIMITS = FIXTURE.upgradeBoostLimits;

interface BoostAmountVector {
  boostCents: number;
  decision: 'accepted' | 'refused';
  chancePpm?: number;
  chanceCompact?: string;
  refusal?: BoostRefusal;
  boostMaxCents?: number;
}

interface BoostKeyVector {
  points: number;
  boostCents: number;
  chancePpm: number;
  chanceCompact: string;
}

interface BoostCaseVector {
  id: string;
  heldSlotIndex: number;
  targetSlotIndex: number;
  stakedBuyBackValueCents: number;
  targetBuyBackValueCents: number;
  casinoMaxCents: number;
  casinoMaxChancePpm: number;
  /** The chance with no amount. Compared, never read. */
  plainChancePpm: number;
  boostMaxCents: number;
  keyPoints?: number[];
  keys?: BoostKeyVector[];
  amounts: BoostAmountVector[];
}

interface BoostStepVector extends RateStepVector {
  /** 0 for a step with no amount; the record then carries no amount at all. */
  boostCents: number;
}

interface BoostFamily extends BoxFamily {
  cases: BoostCaseVector[];
  steps?: BoostStepVector[];
}

/** Both version 4 bodies, by name, each with its own families. */
const BOOST_SECTIONS: readonly [string, { constants: typeof BOOST_CHANCE.constants; families: BoostFamily[] }][] = [
  ['upgradeBoostChance', BOOST_CHANCE],
  ['upgradeBoostLimits', BOOST_LIMITS],
];

/** The step of a case or a step vector, from the family's box: the two values are the slots', never the vector's. */
function boostStepFor(family: BoostFamily, vector: { heldSlotIndex: number; targetSlotIndex: number; stakedBuyBackValueCents: number; targetBuyBackValueCents: number }, rate: number): BoostStep {
  const edition = rateEdition(family, 4);
  const valueOf = (slotIndex: number) => edition.slots.find((slot) => slot.slotIndex === slotIndex)?.requiredBuyBackValueCents;
  const staked = valueOf(vector.heldSlotIndex);
  const target = valueOf(vector.targetSlotIndex);
  assert.equal(staked, BigInt(vector.stakedBuyBackValueCents), "the staked value is the held slot's");
  assert.equal(target, BigInt(vector.targetBuyBackValueCents), "the target value is the named slot's");
  return { engineVersion: 4, rateBps: rate, stakedCents: staked as bigint, targetCents: target as bigint };
}

/**
 * One case of a version 4 family, every number computed by the library and compared with the vector:
 * the chance with no amount, the highest amount, each amount's decision and each key. Throws on the first
 * difference, so a doctored copy of a case is refused (the self-tests below).
 * Refs: KAN-1569 plan v1.1 T2
 */
function checkBoostCase(family: BoostFamily, vector: BoostCaseVector, rate: number): void {
  const where = `${family.id}/${vector.id}`;
  const step = boostStepFor(family, vector, rate);
  const limits: BoostLimits = { maxCents: BigInt(vector.casinoMaxCents), maxChancePpm: vector.casinoMaxChancePpm };
  assert.equal(boostChancePpm(step, 0n), vector.plainChancePpm, `${where}: the chance with no amount`);
  assert.equal(boostMaxCents(step, limits), BigInt(vector.boostMaxCents), `${where}: the highest amount`);
  for (const amount of vector.amounts) {
    const expected: BoostDecision =
      amount.decision === 'accepted'
        ? { decision: 'accepted', boostCents: BigInt(amount.boostCents), chancePpm: amount.chancePpm as number }
        : { decision: 'refused', refusal: amount.refusal as BoostRefusal, boostMaxCents: BigInt(amount.boostMaxCents as number) };
    assert.deepEqual(boostDecision(step, BigInt(amount.boostCents), limits), expected, `${where}: ${amount.boostCents} cents`);
    if (amount.decision === 'accepted') {
      assert.equal(stepChanceText(amount.chancePpm as number), amount.chanceCompact, `${where}: ${amount.boostCents} cents, chanceCompact`);
    }
  }
  const points = vector.keyPoints ?? [];
  const keys = vector.keys ?? [];
  for (const key of keys) assert.ok(points.includes(key.points), `${where}: key +${key.points} is not one of the case's keyPoints`);
  for (const p of points) {
    const written = keys.find((key) => key.points === p);
    assert.deepEqual(
      boostKeyFor(step, p, limits),
      written === undefined ? null : { points: p, boostCents: BigInt(written.boostCents), chancePpm: written.chancePpm },
      `${where}: key +${p}`,
    );
    if (written !== undefined) assert.equal(stepChanceText(written.chancePpm), written.chanceCompact, `${where}: key +${p}, chanceCompact`);
  }
  assert.deepEqual(
    boostKeys(step, points, limits),
    keys.map((key) => ({ points: key.points, boostCents: BigInt(key.boostCents), chancePpm: key.chancePpm })),
    `${where}: the keys the step serves`,
  );
}

/**
 * A version 4 step record: the amount is present only when one was added, and written as the /verify route writes
 * it, a decimal string (cto 37069). The vector itself keeps the engine's number: it is an algorithm input.
 */
function boostStepInput(family: BoostFamily, vector: BoostStepVector, edition: Edition, fingerprint: string): UpgradeStepInput {
  const input = rateStepInput(family, vector, edition, fingerprint, BOOST_CHANCE);
  if (vector.boostCents !== 0) input.expected.boostCents = String(vector.boostCents);
  return input;
}

describe('the version 4 sections of the fixture (KAN-1569)', () => {
  it('state version 4 and the constants this library uses for it', () => {
    const rule = upgradeRule(4);
    for (const [name, body] of BOOST_SECTIONS) {
      const c = body.constants;
      assert.equal(c.engineType, UPGRADE_ENGINE_TYPE, name);
      assert.equal(c.engineVersion, rule?.engineVersion, name);
      assert.equal(c.maxSteps, rule?.maxSteps, name);
      assert.equal(c.minChancePpm, rule?.minChancePpm, name);
      assert.equal(c.offerMinChancePpm, rule?.offerMinChancePpm, name);
      assert.equal(c.stepRtpCapBps, rule?.stepRtpCapBps, name);
      assert.equal(c.stepRtpFloorBps, rule?.stepRtpFloorBps, name);
      assert.equal(c.boostCeilingCents, rule?.boostCeilingCents, name);
      assert.equal(c.boostMaxChancePpm, rule?.boostMaxChancePpm, name);
    }
    assert.equal(rule?.roundsUp, true);
    assert.equal(rule?.jumps, true);
  });

  it('carries a commitment that is the digest of its own server seed', async () => {
    assert.equal(await commitment(bytesFromHex(BOOST_CHANCE.serverSeedHex)), BOOST_CHANCE.commitmentHex);
  });

  it('has the families platform P1 named', () => {
    assert.deepEqual(
      BOOST_SECTIONS.map(([name, body]) => [name, body.families.map((family) => family.id)]),
      [
        ['upgradeBoostChance', ['boost-box-c-9400', 'boost-box-a-9300', 'boost-9990']],
        ['upgradeBoostLimits', ['boost-limits-box-a-9300', 'boost-limits-box-c-9400', 'boost-limits-minimum-edge-9300', 'boost-limits-exact-9300']],
      ],
    );
  });

  it('refuses a family whose written rate, S or boxBps is one off its box, either way', () => {
    // As on version 3 (S-7): R comes from the box, never from the family's stepRtpBps.
    for (const [, body] of BOOST_SECTIONS) {
      for (const family of body.families) {
        for (const delta of [-1, 1]) {
          const rate = { ...family, stepRtpBps: family.stepRtpBps + delta };
          assert.throws(() => checkRateFamily(rate, body.constants), new RegExp(`family ${family.id} writes a rate of ${rate.stepRtpBps} bps`));
          const s = { ...family, payoutTimesMillion: String(BigInt(family.payoutTimesMillion) + BigInt(delta)) };
          assert.throws(() => checkRateFamily(s, body.constants), new RegExp(`family ${family.id} writes S = ${s.payoutTimesMillion},`));
          const box = { ...family, boxBps: family.boxBps + delta };
          assert.throws(() => checkRateFamily(box, body.constants), new RegExp(`family ${family.id} writes boxBps ${box.boxBps},`));
        }
      }
    }
  });

  it('refuses a case whose decision, refusal, highest amount or key price is changed', () => {
    // The numbers are computed and compared, never read: a copy with one of them moved must be refused.
    const family = BOOST_LIMITS.families[0] as BoostFamily;
    const rate = checkRateFamily(family, BOOST_LIMITS.constants);
    const vector = family.cases[0];
    assert.doesNotThrow(() => checkBoostCase(family, vector, rate));
    const accepted = vector.amounts.findIndex((amount) => amount.decision === 'accepted');
    const refused = vector.amounts.findIndex((amount) => amount.decision === 'refused');
    const doctor = (change: (copy: BoostCaseVector) => void): BoostCaseVector => {
      const copy = structuredClone(vector);
      change(copy);
      return copy;
    };
    assert.throws(() => checkBoostCase(family, doctor((c) => { c.amounts[accepted] = { boostCents: c.amounts[accepted].boostCents, decision: 'refused', refusal: 'boost_too_high', boostMaxCents: vector.boostMaxCents }; }), rate));
    assert.throws(() => checkBoostCase(family, doctor((c) => { c.amounts[refused].refusal = 'boost_cent_lost'; }), rate));
    assert.throws(() => checkBoostCase(family, doctor((c) => { (c.amounts[accepted].chancePpm as number) += 1; }), rate));
    assert.throws(() => checkBoostCase(family, doctor((c) => { c.boostMaxCents += 1; }), rate));
    assert.throws(() => checkBoostCase(family, doctor((c) => { c.plainChancePpm += 1; }), rate));
    assert.throws(() => checkBoostCase(family, doctor((c) => { (c.keys as BoostKeyVector[])[0].boostCents += 1; }), rate));
    assert.throws(() => checkBoostCase(family, doctor((c) => { (c.keys as BoostKeyVector[]).pop(); }), rate));
  });
});

describe('every version 4 case, from its box', () => {
  for (const [name, body] of BOOST_SECTIONS) {
    for (const family of body.families) {
      it(`${name}/${family.id}`, () => {
        record(name, family.id);
        const rate = checkRateFamily(family, body.constants);
        for (const vector of family.cases) {
          record(name, `${family.id}/${vector.id}`);
          for (const amount of vector.amounts) record(name, `${family.id}/${vector.id}/amount-${amount.boostCents}`);
          for (const p of vector.keyPoints ?? []) record(name, `${family.id}/${vector.id}/key-${p}`);
          checkBoostCase(family, vector, rate);
        }
      });
    }
  }
});

describe('every version 4 step, from its inputs and through verifyUpgradeStep', () => {
  const seed = bytesFromHex(BOOST_CHANCE.serverSeedHex);
  for (const family of BOOST_CHANCE.families as BoostFamily[]) {
    for (const vector of family.steps ?? []) {
      it(`${family.id}/${vector.id}`, async () => {
        record('upgradeBoostChance', `${family.id}/${vector.id}`);
        const rate = checkRateFamily(family, BOOST_CHANCE.constants);
        const step = boostStepFor(family, vector, rate);
        const chance = boostChancePpm(step, BigInt(vector.boostCents));
        assert.equal(chance, vector.chancePpm, 'chance');
        assert.deepEqual(stepTable(chance).map((row) => row.probabilityPpm), vector.stepTablePpm, 'step table');
        const v = (await derive(seed, vector.clientSeed, vector.nonce)).value;
        assert.equal(v, vector.v, 'drawn v');
        const outcome = stepOutcome(v, chance);
        assert.equal(outcome, vector.outcome, 'outcome');
        assert.equal(outcome === 'won' ? 0 : 1, vector.slotIndex, 'slot index');
        assert.equal(stepChanceText(chance), vector.chanceCompact, 'chanceCompact');

        const edition = rateEdition(family, 4);
        const report = await verifyUpgradeStep(boostStepInput(family, vector, edition, await editionFingerprint(edition)));
        assert.equal(report.status, 'verified', report.summary);
        assert.deepEqual(report.notRun, []);
        assert.equal(report.checks.boostAmount?.ok, true);
        assert.equal(report.trace.stepRateBps, family.stepRtpBps);
        // The target is found at the chance with no amount; the amount moves the chance, not the target.
        assert.deepEqual(report.trace.computedOffer, { targetSlotIndex: vector.targetSlotIndex, chancePpm: boostChancePpm(step, 0n) });
        assert.equal(report.trace.computedOutcome, vector.outcome);

        // The same record on a version 3 edition of the same box: an amount fails there, and no amount verifies.
        const asVersion3 = rateEdition(family, 3);
        const onVersion3 = await verifyUpgradeStep(boostStepInput(family, vector, asVersion3, await editionFingerprint(asVersion3)));
        if (vector.boostCents === 0) {
          assert.equal(onVersion3.status, 'verified', onVersion3.summary);
        } else {
          assert.equal(onVersion3.status, 'failed', onVersion3.summary);
          assert.equal(onVersion3.checks.boostAmount?.ok, false);
        }
      });
    }
  }
});

describe('the step check accepts exactly the amounts the engine accepts (SHOULD 2 of 37016)', () => {
  // Every amount of every case, and one cent either side, recorded as a step with its honest chance: the
  // step page verifies it exactly when the engine's own decision (its limits, no casino's) accepts it. The
  // 0.1 % minimum is in the target lookup, so this runs through verifyUpgradeStep and not the limits alone.
  const seed = bytesFromHex(BOOST_CHANCE.serverSeedHex);
  for (const [name, body] of BOOST_SECTIONS) {
    for (const family of body.families) {
      it(`${name}/${family.id}`, async () => {
        const rate = checkRateFamily(family, body.constants);
        const edition = rateEdition(family, 4);
        const fingerprint = await editionFingerprint(edition);
        const v = (await derive(seed, 'alice-seed', 3)).value;
        for (const vector of family.cases) {
          const step = boostStepFor(family, vector, rate);
          const amounts = new Set(vector.amounts.flatMap((a) => [a.boostCents - 1, a.boostCents, a.boostCents + 1]).filter((b) => b >= 1));
          for (const b of amounts) {
            const decision = boostDecision(step, BigInt(b));
            const reaches = step.stakedCents + BigInt(b) >= step.targetCents;
            const chance = reaches ? 999_999 : boostChancePpm(step, BigInt(b));
            const report = await verifyUpgradeStep({
              serverSeedHex: BOOST_CHANCE.serverSeedHex,
              commitmentHex: BOOST_CHANCE.commitmentHex,
              clientSeed: 'alice-seed',
              nonce: 3,
              edition,
              engineType: body.constants.engineType,
              expected: {
                editionFingerprint: fingerprint,
                stakedSlotIndex: vector.heldSlotIndex,
                targetSlotIndex: vector.targetSlotIndex,
                chancePpm: chance,
                chanceCompact: stepChanceText(chance),
                drawnPpmValue: v,
                outcome: stepOutcome(v, chance),
                stepNo: 1,
                boostCents: String(b),
              },
            });
            assert.equal(
              report.status,
              decision.decision === 'accepted' ? 'verified' : 'failed',
              `${family.id}/${vector.id}, ${b} cents: the engine says ${decision.decision}, the step check says ${report.summary}`,
            );
            // A refusal must also fail on the check the page names, for the limit the engine refused it by (library
            // review SHOULD 2): a refusal named by the wrong limit gives the player the wrong reason.
            if (decision.decision === 'refused') {
              const where = `${family.id}/${vector.id}, ${b} cents (${decision.refusal})`;
              if (boostChancePpm(step, 0n) < 1_000) {
                // The 0.1 % minimum is read on the chance with no amount, by the target check, which runs first.
                assert.equal(report.firstFailure?.check, 'upgradeTarget', where);
              } else {
                assert.equal(report.firstFailure?.check, 'boostAmount', where);
                assert.match(report.checks.boostAmount?.computed ?? '', LIMIT_WORDS[refusedBy(step, BigInt(b), decision)], where);
              }
            }
          }
        }
      });
    }
  }
});

/** The words of each limit, as the step check writes its `boostAmount` computed text. */
const LIMIT_WORDS = {
  reachesTarget: /^the value staked plus \d+ cents reaches the target's value$/,
  ceiling: /^\d+ cents is above the ceiling of 100000 cents$/,
  cap: /^\d+ cents gives a chance of \d+ ppm, above the cap of 500000 ppm$/,
  lastCent: /^the last cent of \d+ cents raises nothing: \d+ cents give \d+ ppm too$/,
} as const;

/**
 * The limit the step check must name for an amount the engine refuses, in the order of plan v1.1 §2.2, with the
 * engine's two limits written out (100 000 cents, 500 000 ppm) rather than read from the library. A last cent
 * that raised nothing is `boost_cent_lost`. Above the engine's highest amount (`boost_too_high`) it is the first
 * of: the target's value reached, the ceiling, the cap; else the amount is within both limits, and the engine's
 * highest amount buys the same chance for less, so its last cent raised nothing either.
 */
function refusedBy(step: BoostStep, b: bigint, decision: Extract<BoostDecision, { decision: 'refused' }>): keyof typeof LIMIT_WORDS {
  if (decision.refusal === 'boost_cent_lost') return 'lastCent';
  if (step.stakedCents + b >= step.targetCents) return 'reachesTarget';
  if (b > 100_000n) return 'ceiling';
  if (boostChancePpm(step, b) > 500_000) return 'cap';
  assert.equal(boostChancePpm(step, b), boostChancePpm(step, decision.boostMaxCents), `${b} cents: above the highest amount, within both limits`);
  return 'lastCent';
}

/** The lists a family or a case may carry, each asserted by a loop above. Any other list is a new kind of vector. */
const FAMILY_LISTS = new Set(['slots', 'queries', 'cases', 'steps']);
const CASE_LISTS = new Set(['amounts', 'keyPoints', 'keys']);

interface AnyFamily {
  id: string;
  queries?: unknown[];
  cases?: { id: string; amounts: { boostCents: number }[]; keyPoints?: number[] }[];
  steps?: { id: string }[];
}

/**
 * Every `family/id` a fixture carries, as the loops above record them. A function of the fixture, so a
 * doctored copy can show that it fails closed (below). A body with families lists each family, each query
 * by its place, each case with its amounts and key points, and each step; any list it does not know of,
 * on a family or a case, is refused by name rather than passed over.
 * Refs: KAN-1751, KAN-1569 plan v1.1 T2
 */
function expectedVectorIds(fixture: Record<string, unknown>): string[] {
  const ids = Object.entries(fixture)
    .filter(([key]) => !METADATA_KEYS.has(key))
    .flatMap(([section, body]) => {
      const families = (body as { families?: AnyFamily[] }).families;
      if (families !== undefined) {
        return families.flatMap((f) => {
          const where = `${section}/${f.id}`;
          for (const [key, value] of Object.entries(f)) {
            if (Array.isArray(value) && !FAMILY_LISTS.has(key)) {
              throw new Error(`family ${where} carries the list '${key}', which this suite never asserts`);
            }
          }
          for (const c of f.cases ?? []) {
            for (const [key, value] of Object.entries(c)) {
              if (Array.isArray(value) && !CASE_LISTS.has(key)) {
                throw new Error(`case ${where}/${c.id} carries the list '${key}', which this suite never asserts`);
              }
            }
          }
          return [
            where,
            ...(f.queries ?? []).map((_, i) => `${where}/query-${i}`),
            ...(f.cases ?? []).flatMap((c) => [
              `${where}/${c.id}`,
              ...c.amounts.map((amount) => `${where}/${c.id}/amount-${amount.boostCents}`),
              ...(c.keyPoints ?? []).map((p) => `${where}/${c.id}/key-${p}`),
            ]),
            ...(f.steps ?? []).map((step) => `${where}/${step.id}`),
          ];
        });
      }
      const vectors = (body as { vectors?: { id: string }[] }).vectors;
      if (!vectors?.length) {
        throw new Error(
          `the fixture carries '${section}', which this suite never asserts. If it is a vector ` +
            'family, write its conformance test — a family the verifier ignores is a claim it ' +
            'cannot make. If it is new metadata, add it to METADATA_KEYS.',
        );
      }
      return vectors.map((vector) => `${section}/${vector.id}`);
    });
  // Two vectors with one id would be counted once: the second would go unasserted in silence.
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length > 0) throw new Error(`the fixture names these vectors twice: ${twice.join(', ')}`);
  return ids;
}

/** Throws unless `reached` is exactly the fixture's vectors, sorted so a failure names the missing ones. */
function checkEveryVectorAsserted(fixture: Record<string, unknown>, reached: ReadonlySet<string>): void {
  assert.deepEqual([...reached].sort(), expectedVectorIds(fixture).sort());
}

describe('the completeness check fails closed (KAN-1569 plan v1.1 T2)', () => {
  // The check is a function of the fixture, so each doctored copy below must make it throw, against a
  // ledger that holds exactly the real fixture's vectors.
  const reached = new Set(expectedVectorIds(FIXTURE));
  const withBody = (key: string, body: unknown) => ({ ...FIXTURE, [key]: body });

  it('passes the real fixture', () => {
    assert.doesNotThrow(() => checkEveryVectorAsserted(FIXTURE, reached));
  });

  it('refuses an extra version 4 family with cases and no steps', () => {
    const families = [...BOOST_LIMITS.families, { ...BOOST_LIMITS.families[0], id: 'doctored-extra' }];
    assert.throws(() => checkEveryVectorAsserted(withBody('upgradeBoostLimits', { ...BOOST_LIMITS, families }), reached));
  });

  it('refuses a new body whose family has only cases', () => {
    const body = { families: [{ id: 'doctored', cases: [{ id: 'one', amounts: [{ boostCents: 1 }] }] }] };
    assert.throws(() => checkEveryVectorAsserted(withBody('upgradeBoostDoctored', body), reached));
  });

  it('refuses an extra amount or key point in a case, and a list it does not know of', () => {
    const doctor = (change: (copy: typeof BOOST_LIMITS) => void) => {
      const copy = structuredClone(BOOST_LIMITS);
      change(copy);
      return withBody('upgradeBoostLimits', copy);
    };
    assert.throws(() => checkEveryVectorAsserted(doctor((c) => c.families[0].cases[0].amounts.push({ boostCents: 7, decision: 'accepted' })), reached));
    assert.throws(() => checkEveryVectorAsserted(doctor((c) => c.families[0].cases[0].keyPoints.push(50)), reached));
    assert.throws(() => checkEveryVectorAsserted(doctor((c) => { c.families[0].cases[0].openings = [1]; }), reached), /carries the list 'openings'/);
    assert.throws(() => checkEveryVectorAsserted(doctor((c) => { c.families[0].openings = [1]; }), reached), /carries the list 'openings'/);
  });

  it('refuses two vectors with one id', () => {
    const copy = structuredClone(BOOST_LIMITS);
    copy.families[0].cases[0].amounts.push(structuredClone(copy.families[0].cases[0].amounts[0]));
    assert.throws(() => checkEveryVectorAsserted(withBody('upgradeBoostLimits', copy), reached), /names these vectors twice/);
  });
});

/**
 * Declared LAST on purpose. `node --test` runs top-level suites in definition order and does not
 * overlap them unless asked to, so by the time this runs the ledger above is complete.
 */
describe('no vector in the fixture is left unasserted', () => {
  it('exercises every vector in every family the fixture carries', () => {
    // A NEW family is a hard failure, never a skip. This is the assertion that makes it impossible
    // to add vectors on the platform side and have this library quietly go on proving less: the
    // build here breaks until somebody writes the conformance test for them.
    //
    // One test rather than two (family coverage, then vector coverage) because a new family fails
    // both for the same cause, and one red per cause is easier to act on than two.
    checkEveryVectorAsserted(FIXTURE, asserted);
  });

  it('replays the bulk sweep in full', () => {
    // The sweep has no per-row ids, so it is counted rather than keyed. A `.slice()` or an early
    // `break` slipped into the sweep loop would otherwise shrink coverage invisibly.
    assert.equal(sweepRowsAsserted, FIXTURE.draw.sweep.rows.length);
  });
});
