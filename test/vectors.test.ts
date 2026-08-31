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
  verify,
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
 * stay green while the verifier proved strictly less than the fixture claims. KAN-50 (the 0x03
 * snapshot preimage, which binds a slot to the item in it) is headed for exactly that shape.
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
  /** The §7 seed and nonce 1, drawn against the pinned golden edition. */
  async function input(overrides: Record<string, unknown> = {}) {
    const vector = FIXTURE.editionFingerprint.vectors.find(
      (v: { id: string }) => v.id === 'canonical-unsorted-slots',
    );
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
    assert.equal(report.checks.commitment.ok, true);
    assert.equal(report.checks.editionFingerprint.ok, true);
    assert.equal(report.checks.drawnPpmValue.ok, true);
    assert.equal(report.checks.drawnSlotIndex.ok, true);

    assert.equal(report.trace.message, 'alice-seed:1:0');
    assert.equal(report.trace.hmacHex, FIXTURE.draw.vectors[0].hmacHex);
    assert.equal(report.trace.value, 186_669);
    assert.equal(report.trace.computedEditionFingerprint, report.checks.editionFingerprint.expected);
    assert.match(report.summary, /^Verified:/);
  });

  it('fails when the commitment does not match the revealed seed', async () => {
    const report = await verify(await input({ commitmentHex: 'ab'.repeat(32) }));

    assert.equal(report.ok, false);
    assert.equal(report.checks.commitment.ok, false);
    assert.match(report.summary, /^FAILED: commitment/);
  });

  it('fails when the published odds do not match the recorded fingerprint', async () => {
    // The attack this whole library exists to stop: a genuine draw, replayed against a prize table
    // swapped after the fact. Every other check still passes; this one must not.
    const report = await verify(await input({ expected: { editionFingerprint: 'cd'.repeat(32) } }));

    assert.equal(report.ok, false);
    assert.equal(report.checks.editionFingerprint.ok, false);
    assert.equal(report.checks.commitment.ok, true);
    assert.equal(report.checks.drawnPpmValue.ok, true);
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
    // THE attack KAN-50 exists to stop: a genuinely fair draw, on genuinely fair odds, landing on
    // a real slot — and then a different, cheaper prize reported for it. Every check that existed
    // before this story still passes.
    const report = await verify(
      await inputWithSnapshot({ expected: { itemId: '99999999-9999-9999-9999-999999999999' } }),
    );

    assert.equal(report.ok, false);
    assert.equal(report.checks.drawnItemId?.ok, false);
    assert.equal(report.checks.commitment.ok, true);
    assert.equal(report.checks.editionFingerprint.ok, true);
    assert.equal(report.checks.drawnPpmValue.ok, true);
    assert.equal(report.checks.drawnSlotIndex.ok, true);
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

  it('refuses to pretend when a snapshot arrives without the claims to check it against', async () => {
    // The key is REMOVED, not set to undefined: `exactOptionalPropertyTypes` makes those two
    // different types, and it is the absent-key case a real caller produces.
    const base = await inputWithSnapshot();
    const { itemId: _omitted, ...expectedWithoutItem } = base.expected;
    await assert.rejects(
      () => verify({ ...base, expected: expectedWithoutItem }),
      /expected.snapshotHash and expected.itemId are required/,
    );
  });
});

/**
 * Declared LAST on purpose. `node --test` runs top-level suites in definition order and does not
 * overlap them unless asked to, so by the time this runs the ledger above is complete.
 */
describe('no vector in the fixture is left unasserted', () => {
  const families = Object.entries(FIXTURE).filter(([key]) => !METADATA_KEYS.has(key));

  it('exercises every vector in every family the fixture carries', () => {
    // A NEW family is a hard failure, never a skip. This is the assertion that makes it impossible
    // to add vectors on the platform side and have this library quietly go on proving less: the
    // build here breaks until somebody writes the conformance test for them.
    //
    // One test rather than two (family coverage, then vector coverage) because a new family fails
    // both for the same cause, and one red per cause is easier to act on than two.
    const expected = families.flatMap(([family, body]) => {
      const vectors = (body as { vectors?: { id: string }[] }).vectors;
      assert.ok(
        vectors?.length,
        `the fixture carries '${family}', which this suite never asserts. If it is a vector ` +
          'family, write its conformance test — a family the verifier ignores is a claim it ' +
          'cannot make. If it is new metadata, add it to METADATA_KEYS.',
      );
      return vectors.map((vector) => `${family}/${vector.id}`);
    });

    // Sorted so a failure names the missing vectors rather than showing two shuffled lists.
    assert.deepEqual([...asserted].sort(), expected.sort());
  });

  it('replays the bulk sweep in full', () => {
    // The sweep has no per-row ids, so it is counted rather than keyed. A `.slice()` or an early
    // `break` slipped into the sweep loop would otherwise shrink coverage invisibly.
    assert.equal(sweepRowsAsserted, FIXTURE.draw.sweep.rows.length);
  });
});
