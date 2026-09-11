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
  parseSnapshot,
  parseSnapshotBody,
  slotFor,
  snapshotBytes,
  snapshotHash,
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

  /**
   * Every `family/id` this pass actually reached, populated as the loops run.
   *
   * Recorded rather than declared: an allow-list of family names would state that a family is
   * covered, where this proves it. Deleting or short-circuiting one of the loops below empties the
   * corresponding keys and the completeness check at the end fails — which an allow-list would sail
   * straight past, reporting green having asserted nothing.
   */
  const asserted = new Set();

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
    asserted.add(`draw/${vector.id}`);
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
    asserted.add(`slotMapping/${vector.id}`);
    const derivation = await derive(seed, vector.clientSeed, vector.nonce);
    eq(`slot:${vector.id}.v`, derivation.value, vector.v);
    eq(`slot:${vector.id}.slotIndex`, slotFor(vector.v, vector.slotsAsGiven), vector.slotIndex);
  }

  // --- the edition fingerprint (BigInt round-trip through the browser's own engine) ---
  for (const vector of fixture.editionFingerprint.vectors) {
    asserted.add(`editionFingerprint/${vector.id}`);
    const edition = parseEdition({ ...vector.edition, slots: vector.edition.slotsAsGiven });
    eq(`edition:${vector.id}.preimage`, hexFromBytes(editionBytes(edition)), vector.preimageHex);
    eq(`edition:${vector.id}.fingerprint`, await editionFingerprint(edition), vector.editionFingerprint);
  }

  // --- the snapshot content address (TextEncoder is the browser's own, not Node's) ---
  // Worth running here specifically: the UTF-8 length prefix goes through each engine's TextEncoder,
  // and the multi-byte vector is the one that would expose a divergence.
  for (const vector of fixture.snapshot.vectors) {
    asserted.add(`snapshot/${vector.id}`);
    const snapshot = parseSnapshot({
      editionFingerprint: vector.editionFingerprint,
      slots: vector.slotsAsGiven,
    });
    eq(`snapshot:${vector.id}.preimage`, hexFromBytes(snapshotBytes(snapshot)), vector.preimageHex);
    eq(`snapshot:${vector.id}.hash`, await snapshotHash(snapshot), vector.snapshotHash);
    eq(`snapshot:${vector.id}.fromBody`, await snapshotHash(parseSnapshotBody(vector.body)), vector.snapshotHash);
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
  // Without a snapshot the item is unproven, and the report must SAY so rather than print a bare
  // green — the browser pass is the one a player actually sees the consequences of.
  eq('verify.caveats', report.caveats.length, 1);

  const snapshotVector = fixture.snapshot.vectors.find((v) => v.id === 'chains-onto-canonical-edition');
  const drawnSlot = slotFor(186669, edition.slots);
  const withSnapshot = await verify({
    serverSeedHex: fixture.draw.serverSeedHex,
    commitmentHex: fixture.draw.commitmentHex,
    clientSeed: 'alice-seed',
    nonce: 1,
    edition,
    snapshot: parseSnapshot({
      editionFingerprint: snapshotVector.editionFingerprint,
      slots: snapshotVector.slotsAsGiven,
    }),
    expected: {
      editionFingerprint: golden.editionFingerprint,
      drawnPpmValue: 186669,
      drawnSlotIndex: drawnSlot,
      snapshotHash: snapshotVector.snapshotHash,
      itemId: snapshotVector.slotsAsGiven.find((s) => s.slotIndex === drawnSlot).currentItemId,
    },
  });
  eq('verifyWithSnapshot.ok', withSnapshot.ok, true);
  eq('verifyWithSnapshot.item', withSnapshot.checks.drawnItemId.ok, true);
  eq('verifyWithSnapshot.chain', withSnapshot.checks.snapshotEditionLink.ok, true);
  eq('verifyWithSnapshot.caveats', withSnapshot.caveats.length, 0);

  // --- the same fail-closed completeness check the Node suite makes ---
  // Without it the guarantee would hold in Node only: a family added on the platform side would
  // redden `npm test` while this pass went on silently proving less, in the three engines a player
  // actually runs. Compared against what the loops above REACHED, so it catches a deleted loop as
  // well as a new family. METADATA_KEYS is the one literal here and must stay in step with its twin
  // in `test/vectors.test.ts`; the failure names that explicitly so a drift is not a puzzle.
  const METADATA_KEYS = ['formatVersion', 'source', 'specification', 'notes'];
  const expected = [];
  for (const [key, body] of Object.entries(fixture)) {
    if (METADATA_KEYS.includes(key)) continue;
    const vectors = body && body.vectors;
    if (!vectors || vectors.length === 0) {
      failures.push(
        `fixture carries '${key}', which this browser pass never asserts. If it is a vector ` +
          'family, add a loop for it here and in test/vectors.test.ts; if it is new metadata, ' +
          'add it to METADATA_KEYS in BOTH files.',
      );
      continue;
    }
    for (const vector of vectors) expected.push(`${key}/${vector.id}`);
  }
  checked++;
  const missing = expected.filter((key) => !asserted.has(key));
  if (missing.length > 0) {
    failures.push(`vectors present in the fixture but never asserted here: ${missing.join(', ')}`);
  }

  return { checked, failures };
}
