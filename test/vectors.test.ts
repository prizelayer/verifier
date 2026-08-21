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
  slotFor,
  verify,
} from '../src/verifier.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../fixtures/golden-vectors-v1.json', import.meta.url), 'utf8'),
);

const SERVER_SEED = bytesFromHex(FIXTURE.draw.serverSeedHex);

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
});
