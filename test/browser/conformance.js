/**
 * The conformance pass, written once and run inside a real browser engine.
 *
 * The Node suite (`test/vectors.test.ts`) is the detailed one. This exists to answer a narrower
 * question that Node cannot: does the SAME built file, driven by a browser's own Web Crypto
 * implementation, produce the same numbers? Chromium, Firefox and WebKit each ship their own
 * SHA-256 and HMAC, and "it worked in Node" is not evidence about any of them.
 *
 * Plain JavaScript on purpose — the page imports `dist/verifier.js` exactly as a third party would,
 * with no compile step of its own standing between the artifact and the assertions.
 */
import {
  ACCEPTANCE_THRESHOLD,
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
} from '../../dist/verifier.js';

/**
 * Run every vector family against the library.
 *
 * @returns `{ checked, failures }` — failures carry a human-readable label so a red browser run
 *   names the exact vector that diverged instead of just failing.
 */
export async function runConformance(fixture) {
  const failures = [];
  let checked = 0;

  const eq = (label, actual, expected) => {
    checked++;
    if (String(actual) !== String(expected)) {
      failures.push(`${label}: expected ${expected}, got ${actual}`);
    }
  };

  const seed = bytesFromHex(fixture.draw.serverSeedHex);

  // --- constants + commitment ---
  eq('constants.serverSeedBytes', fixture.draw.constants.serverSeedBytes, SERVER_SEED_BYTES);
  eq('constants.acceptanceThreshold', fixture.draw.constants.acceptanceThreshold, ACCEPTANCE_THRESHOLD);
  eq('constants.ppmTotal', fixture.draw.constants.ppmTotal, PPM_TOTAL);
  eq('commitment', await commitment(seed), fixture.draw.commitmentHex);

  // --- the draw ---
  for (const vector of fixture.draw.vectors) {
    const actual = await derive(seed, vector.clientSeed, vector.nonce);
    eq(`draw:${vector.id}.message`, actual.message, vector.message);
    eq(`draw:${vector.id}.hmac`, actual.hmacHex, vector.hmacHex);
    eq(`draw:${vector.id}.attempt`, actual.attempt, vector.attempt);
    eq(`draw:${vector.id}.offset`, actual.offset, vector.offset);
    eq(`draw:${vector.id}.acceptedChunk`, actual.acceptedChunk, vector.acceptedChunk);
    eq(`draw:${vector.id}.ppm`, actual.value, vector.ppm);
    eq(`draw:${vector.id}.rejectedCount`, actual.rejected.length, vector.rejected.length);
    vector.rejected.forEach((expected, i) => {
      eq(`draw:${vector.id}.rejected[${i}].offset`, actual.rejected[i]?.offset, expected.offset);
      eq(`draw:${vector.id}.rejected[${i}].chunk`, actual.rejected[i]?.chunk, expected.chunk);
    });
  }

  // --- the bulk sweep ---
  for (const row of fixture.draw.sweep.rows) {
    const actual = await derive(seed, fixture.draw.sweep.clientSeed, row.nonce);
    eq(`sweep:${row.nonce}.attempt`, actual.attempt, row.attempt);
    eq(`sweep:${row.nonce}.offset`, actual.offset, row.offset);
    eq(`sweep:${row.nonce}.ppm`, actual.value, row.ppm);
  }

  // --- the slot mapping (slotsAsGiven is unsorted on purpose) ---
  for (const vector of fixture.slotMapping.vectors) {
    const derivation = await derive(seed, vector.clientSeed, vector.nonce);
    eq(`slot:${vector.id}.v`, derivation.value, vector.v);
    eq(`slot:${vector.id}.slotIndex`, slotFor(vector.v, vector.slotsAsGiven), vector.slotIndex);
  }

  // --- the edition fingerprint (BigInt round-trip through the browser's own engine) ---
  for (const vector of fixture.editionFingerprint.vectors) {
    const edition = parseEdition({ ...vector.edition, slots: vector.edition.slotsAsGiven });
    eq(`edition:${vector.id}.preimage`, hexFromBytes(editionBytes(edition)), vector.preimageHex);
    eq(`edition:${vector.id}.fingerprint`, await editionFingerprint(edition), vector.editionFingerprint);
  }

  // --- one whole verification, the way the UI will call it ---
  const golden = fixture.editionFingerprint.vectors.find((v) => v.id === 'canonical-unsorted-slots');
  const edition = parseEdition({ ...golden.edition, slots: golden.edition.slotsAsGiven });
  const report = await verify({
    serverSeedHex: fixture.draw.serverSeedHex,
    commitmentHex: fixture.draw.commitmentHex,
    clientSeed: 'alice-seed',
    nonce: 1,
    edition,
    expected: {
      editionFingerprint: golden.editionFingerprint,
      drawnPpmValue: 186669,
      drawnSlotIndex: slotFor(186669, edition.slots),
    },
  });
  eq('verify.ok', report.ok, true);
  eq('verify.trace.hmac', report.trace.hmacHex, fixture.draw.vectors[0].hmacHex);

  // --- the same fail-closed family check the Node suite makes ---
  // Without this the guarantee would hold in Node only: a family added on the platform side would
  // redden `npm test` while this pass went on silently proving less, in the three engines a player
  // actually runs. Kept as literals rather than imported because this file is deliberately plain
  // JS loaded straight into the page; it must stay in step with METADATA_KEYS and the loops above
  // in `test/vectors.test.ts`.
  const METADATA_KEYS = ['formatVersion', 'source', 'specification', 'notes'];
  const COVERED_FAMILIES = ['draw', 'slotMapping', 'editionFingerprint'];
  for (const key of Object.keys(fixture)) {
    checked++;
    if (!METADATA_KEYS.includes(key) && !COVERED_FAMILIES.includes(key)) {
      failures.push(
        `fixture carries '${key}', which this browser pass never asserts. If it is a vector ` +
          'family, add it here and to test/vectors.test.ts; if it is new metadata, list it above.',
      );
    }
  }

  return { checked, failures };
}
