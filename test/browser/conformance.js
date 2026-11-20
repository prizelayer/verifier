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
  UPGRADE_ENGINE_TYPE,
  UPGRADE_ENGINE_VERSION,
  UPGRADE_JUMP_MIN_CHANCE_PPM,
  UPGRADE_MAX_STEPS,
  UPGRADE_MIN_CHANCE_PPM,
  UPGRADE_RULES,
  UPGRADE_STEP_RTP_BPS,
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
  upgradeRule,
  upgradeTarget,
  upgradeTargets,
  verify,
  verifyUpgradeStep,
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
  eq('verifyWithSnapshot.status', withSnapshot.status, 'verified');

  // A seed that is not revealed yet is the state most lookups meet first. The odds must still be
  // checked, in the browser's own Web Crypto, and the report must not pass.
  const pending = await verify({
    serverSeedHex: null,
    commitmentHex: fixture.draw.commitmentHex,
    clientSeed: 'alice-seed',
    nonce: 1,
    edition,
    expected: { editionFingerprint: golden.editionFingerprint, drawnPpmValue: 186669, drawnSlotIndex: drawnSlot },
  });
  eq('verifyPending.status', pending.status, 'pending');
  eq('verifyPending.ok', pending.ok, false);
  eq('verifyPending.fingerprint', pending.checks.editionFingerprint.ok, true);

  // --- the upgrade step (KAN-1154 A2): every value recomputed from the section's own inputs ---
  const step = fixture.upgradeStep;
  for (const section of [step, fixture.upgradeOffer]) {
    eq('upgrade.constants.engineType', section.constants.engineType, UPGRADE_ENGINE_TYPE);
    eq('upgrade.constants.maxSteps', section.constants.maxSteps, UPGRADE_MAX_STEPS);
    eq('upgrade.constants.minChancePpm', section.constants.minChancePpm, UPGRADE_MIN_CHANCE_PPM);
    eq('upgrade.constants.engineVersion', section.constants.engineVersion, UPGRADE_ENGINE_VERSION);
    eq('upgrade.constants.stepRtpBps', section.constants.stepRtpBps, UPGRADE_STEP_RTP_BPS);
  }
  const stepSeed = bytesFromHex(step.serverSeedHex);
  eq('upgradeStep.commitment', await commitment(stepSeed), step.commitmentHex);
  for (const vector of step.vectors) {
    asserted.add(`upgradeStep/${vector.id}`);
    const chance = upgradeChancePpm(
      BigInt(vector.stakedBuyBackValueCents),
      BigInt(vector.targetBuyBackValueCents),
    );
    eq(`upgradeStep:${vector.id}.chance`, chance, vector.chancePpm);
    eq(`upgradeStep:${vector.id}.table`, stepTable(chance).map((row) => row.probabilityPpm).join(','),
      vector.stepTablePpm.join(','));
    const v = (await derive(stepSeed, vector.clientSeed, vector.nonce)).value;
    eq(`upgradeStep:${vector.id}.v`, v, vector.v);
    const outcome = stepOutcome(v, chance);
    eq(`upgradeStep:${vector.id}.outcome`, outcome, vector.outcome);
    eq(`upgradeStep:${vector.id}.slotIndex`, outcome === 'won' ? 0 : 1, vector.slotIndex);
    eq(`upgradeStep:${vector.id}.chanceCompact`, stepChanceText(chance), vector.chanceCompact);
  }

  // --- the upgrade offer: the library's target, plus the cap and the engine type ---
  for (const vector of fixture.upgradeOffer.vectors) {
    asserted.add(`upgradeOffer/${vector.id}`);
    // Only the buy-back values take part in an offer; the odds must still be a valid table.
    const slots = vector.slotsAsGiven.map((slot, i) => ({
      slotIndex: slot.slotIndex,
      probabilityPpm: i === 0 ? PPM_TOTAL : 0,
      requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
      requiredMarketValueCents: 0n,
    }));
    for (const query of vector.queries) {
      const label = `upgradeOffer:${vector.id}[held ${query.heldSlotIndex}, step ${query.stepNo}]`;
      let actual;
      if (vector.engineType !== UPGRADE_ENGINE_TYPE) actual = 'none:not_upgrade_engine';
      else if (query.stepNo >= UPGRADE_MAX_STEPS) actual = 'none:cap_reached';
      else {
        const offer = upgradeTarget({ slots }, query.heldSlotIndex);
        if (offer !== null) actual = `${offer.targetSlotIndex}@${offer.chancePpm}`;
        else {
          const held = slots.find((slot) => slot.slotIndex === query.heldSlotIndex);
          const higher = slots.some((slot) => slot.requiredBuyBackValueCents > held.requiredBuyBackValueCents);
          actual = higher ? 'none:under_minimum' : 'none:top_value';
        }
      }
      const expected = query.noOfferReason
        ? `none:${query.noOfferReason}`
        : `${query.targetSlotIndex}@${query.chancePpm}`;
      eq(label, actual, expected);
      eq(`${label}.chanceCompact`, query.chancePpm === undefined ? undefined : stepChanceText(query.chancePpm), query.chanceCompact);
    }
  }

  // --- version 2 of the upgrade engine (KAN-1567): the target list and the worst path ---
  // The same recomputations as test/vectors.test.ts, from the built file: the list is the library's
  // upgradeTargets, and the worst path is built from that list alone.
  for (const section of [fixture.upgradeTargets, fixture.upgradeWorstPath]) {
    eq('upgradeV2.constants.engineType', section.constants.engineType, UPGRADE_ENGINE_TYPE);
    eq('upgradeV2.constants.engineVersions', section.constants.engineVersions.join(','),
      UPGRADE_RULES.map((rule) => rule.engineVersion).join(','));
    eq('upgradeV2.constants.maxSteps', section.constants.maxSteps, UPGRADE_MAX_STEPS);
    eq('upgradeV2.constants.minChancePpm', section.constants.minChancePpm, upgradeRule(1)?.minChancePpm);
    eq('upgradeV2.constants.jumpMinChancePpm', section.constants.jumpMinChancePpm, upgradeRule(2)?.minChancePpm);
    eq('upgradeV2.constants.jumpMinChancePpm.export', section.constants.jumpMinChancePpm, UPGRADE_JUMP_MIN_CHANCE_PPM);
    eq('upgradeV2.constants.stepRtpBps', section.constants.stepRtpBps, UPGRADE_STEP_RTP_BPS);
  }

  // Only the buy-back values take part in a list; the odds must still be a valid table.
  const valueSlots = (slotsAsGiven) => slotsAsGiven.map((slot, i) => ({
    slotIndex: slot.slotIndex,
    probabilityPpm: i === 0 ? PPM_TOTAL : 0,
    requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
    requiredMarketValueCents: 0n,
  }));

  for (const vector of fixture.upgradeTargets.vectors) {
    asserted.add(`upgradeTargets/${vector.id}`);
    const slots = valueSlots(vector.slotsAsGiven);
    const kinds = new Map(vector.slotsAsGiven.map((slot) => [slot.slotIndex, slot.kind]));
    for (const query of vector.queries) {
      const label = `upgradeTargets:${vector.id}[held ${query.heldSlotIndex}, step ${query.stepNo}]`;
      // The single offer is the upgradeOffer rule on every version; the list is the version's own.
      const open = vector.engineType === UPGRADE_ENGINE_TYPE && query.stepNo < UPGRADE_MAX_STEPS;
      let offer;
      if (vector.engineType !== UPGRADE_ENGINE_TYPE) offer = 'none:not_upgrade_engine';
      else if (!open) offer = 'none:cap_reached';
      else {
        const single = upgradeTarget({ slots }, query.heldSlotIndex);
        if (single !== null) offer = `${single.targetSlotIndex}@${single.chancePpm}=${stepChanceText(single.chancePpm)}`;
        else {
          const held = slots.find((slot) => slot.slotIndex === query.heldSlotIndex);
          const higher = slots.some((slot) => slot.requiredBuyBackValueCents > held.requiredBuyBackValueCents);
          offer = higher ? 'none:under_minimum' : 'none:top_value';
        }
      }
      eq(`${label}.offer`, offer, query.noOfferReason
        ? `none:${query.noOfferReason}`
        : `${query.targetSlotIndex}@${query.chancePpm}=${query.chanceCompact}`);
      const listed = open ? upgradeTargets({ slots }, query.heldSlotIndex, vector.engineVersion) : [];
      eq(`${label}.targets`,
        listed.map((t) => `${t.targetSlotIndex}:${kinds.get(t.targetSlotIndex)}@${t.chancePpm}=${stepChanceText(t.chancePpm)}`).join(','),
        query.targets.map((t) => `${t.targetSlotIndex}:${t.kind}@${t.chancePpm}=${t.chanceCompact}`).join(','));
    }
  }

  // The worst path, scaled by 1 000 000^(1 + MAX_STEPS) so no division happens before the end: a win at
  // depth d with no target is worth its value x 1 000 000^(MAX_STEPS - d), else the least of chance x the
  // target's worth at d + 1 (worstPathScaled in test/vectors.test.ts).
  const MILLION = BigInt(PPM_TOTAL);
  const lowestTerms = (numerator, denominator) => {
    let a = numerator;
    let b = denominator;
    while (b !== 0n) [a, b] = [b, a % b];
    return `${numerator / a}/${denominator / a}`;
  };
  const percentFloor6 = (numerator, denominator) => {
    const millionths = (numerator * 100n * 1_000_000n) / denominator;
    return `${millionths / 1_000_000n}.${String(millionths % 1_000_000n).padStart(6, '0')}%`;
  };
  for (const vector of fixture.upgradeWorstPath.vectors) {
    asserted.add(`upgradeWorstPath/${vector.id}`);
    const label = `upgradeWorstPath:${vector.id}`;
    eq(`${label}.engineType`, vector.engineType, UPGRADE_ENGINE_TYPE);
    const slots = vector.slots.map((slot) => ({
      slotIndex: slot.slotIndex,
      probabilityPpm: slot.probabilityPpm,
      requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
      requiredMarketValueCents: 0n,
    }));
    let deeper = new Map();
    for (let depth = UPGRADE_MAX_STEPS; depth >= 0; depth--) {
      const here = new Map();
      for (const slot of slots) {
        const targets = depth >= UPGRADE_MAX_STEPS ? [] : upgradeTargets({ slots }, slot.slotIndex, vector.engineVersion);
        here.set(slot.slotIndex, targets.length === 0
          ? slot.requiredBuyBackValueCents * MILLION ** BigInt(UPGRADE_MAX_STEPS - depth)
          : targets
            .map((target) => BigInt(target.chancePpm) * deeper.get(target.targetSlotIndex))
            .reduce((least, payout) => (payout < least ? payout : least)));
      }
      deeper = here;
    }
    const worst = slots.reduce((sum, slot) => sum + BigInt(slot.probabilityPpm) * deeper.get(slot.slotIndex), 0n);
    const scale = MILLION ** BigInt(1 + UPGRADE_MAX_STEPS);
    const price = BigInt(vector.priceCents);
    const fraction = (f) => `${f.numerator}/${f.denominator}`;
    eq(`${label}.payout`, lowestTerms(worst, scale), fraction(vector.worstPathPayoutCents));
    eq(`${label}.rtp`, lowestTerms(worst, scale * price), fraction(vector.worstPathRtp));
    eq(`${label}.rtpText`, percentFloor6(worst, scale * price), vector.worstPathRtpText);
    // The box returns the sum of ppm x value over 1 000 000 x price; it and the worst path must both reach the floor.
    const box = slots.reduce((sum, slot) => sum + BigInt(slot.probabilityPpm) * slot.requiredBuyBackValueCents, 0n);
    eq(`${label}.verdicts`,
      vector.verdicts.map(({ floorBps }) => `${floorBps}:${
        box * 10_000n >= BigInt(floorBps) * MILLION * price && worst * 10_000n >= BigInt(floorBps) * scale * price}`).join(','),
      vector.verdicts.map(({ floorBps, meetsFloor }) => `${floorBps}:${meetsFloor}`).join(','));
  }

  // --- a version 2 step to a named target (KAN-1567): v from this browser's own HMAC, and the whole step
  // check a page calls, verifyUpgradeStep, on a version 2 edition of the vector's slots ---
  const jump = fixture.upgradeJumpStep;
  eq('upgradeJumpStep.constants.engineType', jump.constants.engineType, UPGRADE_ENGINE_TYPE);
  eq('upgradeJumpStep.constants.engineVersion', jump.constants.engineVersion, 2);
  eq('upgradeJumpStep.constants.jumpMinChancePpm', jump.constants.jumpMinChancePpm, upgradeRule(2)?.minChancePpm);
  eq('upgradeJumpStep.constants.maxSteps', jump.constants.maxSteps, UPGRADE_MAX_STEPS);
  const jumpSeed = bytesFromHex(jump.serverSeedHex);
  eq('upgradeJumpStep.commitment', await commitment(jumpSeed), jump.commitmentHex);
  for (const vector of jump.vectors) {
    asserted.add(`upgradeJumpStep/${vector.id}`);
    const label = `upgradeJumpStep:${vector.id}`;
    const slots = valueSlots(vector.slotsAsGiven);
    const valueOf = (slotIndex) => slots.find((slot) => slot.slotIndex === slotIndex)?.requiredBuyBackValueCents;
    eq(`${label}.stakedValue`, valueOf(vector.heldSlotIndex), vector.stakedBuyBackValueCents);
    eq(`${label}.targetValue`, valueOf(vector.targetSlotIndex), vector.targetBuyBackValueCents);
    const chance = upgradeChancePpm(BigInt(vector.stakedBuyBackValueCents), BigInt(vector.targetBuyBackValueCents));
    eq(`${label}.chance`, chance, vector.chancePpm);
    // Version 2's rule: the named slot is one of the list (worth more, at 1 % or more); version 1 does not offer it.
    const listed = upgradeTargets({ slots }, vector.heldSlotIndex, jump.constants.engineVersion)
      .find((target) => target.targetSlotIndex === vector.targetSlotIndex);
    eq(`${label}.listed`, listed && `${listed.targetSlotIndex}@${listed.chancePpm}`, `${vector.targetSlotIndex}@${vector.chancePpm}`);
    eq(`${label}.notVersion1`, upgradeTarget({ slots }, vector.heldSlotIndex)?.targetSlotIndex === vector.targetSlotIndex, false);
    eq(`${label}.table`, stepTable(chance).map((row) => row.probabilityPpm).join(','), vector.stepTablePpm.join(','));
    const v = (await derive(jumpSeed, vector.clientSeed, vector.nonce)).value;
    eq(`${label}.v`, v, vector.v);
    const outcome = stepOutcome(v, chance);
    eq(`${label}.outcome`, outcome, vector.outcome);
    eq(`${label}.slotIndex`, outcome === 'won' ? 0 : 1, vector.slotIndex);
    eq(`${label}.chanceCompact`, stepChanceText(chance), vector.chanceCompact);
    // The fingerprint is computed here, so the engine id and the price are any fixed values.
    const edition = { engineId: '15671567-0000-4000-8000-000000000002', engineVersion: 2, priceCents: 2000n, slots };
    const report = await verifyUpgradeStep({
      serverSeedHex: jump.serverSeedHex,
      commitmentHex: jump.commitmentHex,
      clientSeed: vector.clientSeed,
      nonce: vector.nonce,
      edition,
      engineType: jump.constants.engineType,
      expected: {
        editionFingerprint: await editionFingerprint(edition),
        stakedSlotIndex: vector.heldSlotIndex,
        targetSlotIndex: vector.targetSlotIndex,
        chancePpm: vector.chancePpm,
        chanceCompact: vector.chanceCompact,
        drawnPpmValue: vector.v,
        outcome: vector.outcome,
        // The vector's stepNo is the held win's; the step record carries the step's own number.
        stepNo: vector.stepNo + 1,
      },
    });
    eq(`${label}.verifyUpgradeStep`, report.status, 'verified');
  }

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
