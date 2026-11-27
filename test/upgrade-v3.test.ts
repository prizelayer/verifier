/**
 * Version 3 of the upgrade engine (ADR-KAN-1154 amendment 8): the box's own rate, the chance rounded up,
 * the minimum of 0.1 % for a named target and the single offer, and no limit on steps.
 *
 * Every number here is a worked number of amendment 8 (§8.3, §8.4, §8.6, §8.12), computed by hand from the
 * rule in integers and never from the platform's code. The platform's version 3 golden vectors (KAN-1751
 * PR-1b2) are checked in vectors.test.ts once they exist; these literals stay as the second record.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';

import {
  type Edition,
  type UpgradeStepInput,
  editionFingerprint,
  stepChanceText,
  upgradeChancePpm,
  upgradeStepRateBps,
  upgradeTarget,
  upgradeTargets,
  UPGRADE_ENGINE_TYPE,
  UPGRADE_MAX_CHAIN,
  verifyUpgradeStep,
} from '../src/verifier.js';

/** An edition from buy-back cents and ppm, each slot's market value equal to its buy-back value. */
function box(priceCents: bigint, values: bigint[], ppm: number[], engineVersion = 3): Edition {
  return {
    engineId: '00000000-0000-4000-8000-00000000e003',
    engineVersion,
    priceCents,
    slots: values.map((cents, slotIndex) => ({
      slotIndex,
      probabilityPpm: ppm[slotIndex]!,
      requiredBuyBackValueCents: cents,
      requiredMarketValueCents: cents,
    })),
  };
}

/** §8.3: 20,00; 5, 12, 20, 45 and 200 at 444 750 / 300 000 / 140 000 / 80 000 / 35 250 ppm; 96.36875 %. */
const WORKED_9636 = box(2000n, [500n, 1200n, 2000n, 4500n, 20000n], [444_750, 300_000, 140_000, 80_000, 35_250]);
/** §8.3, the box of point 1 of the decision: 20,00; 5, 12, 30, 80 at 319 199 / 470 000 / 110 000 / 100 801; 93.000375 %. */
const WORKED_BOX_9300 = box(2000n, [500n, 1200n, 3000n, 8000n], [319_199, 470_000, 110_000, 100_801]);
/** §8.12, the "casino_floor" box: 10,00; 3 and 13 at 360 000 / 640 000; exactly 94.00 %. */
const FLOOR_9400 = box(1000n, [300n, 1300n], [360_000, 640_000]);
/** A box at exactly 95.50 %: 10,00; 1, 10 and 20 at 500 000 / 95 000 / 405 000 (S = 955 000 000). */
const BOX_9550 = box(1000n, [100n, 1000n, 2000n], [500_000, 95_000, 405_000]);
/** A box at 150 %, above 99.90 %: 5,00; 5 and 10 at 500 000 each. */
const ABOVE_CAP = box(500n, [500n, 1000n], [500_000, 500_000]);
/** A box at exactly 99.90 %: 10,00; 5 and 10 at 2 000 / 998 000 (S = 999 000 000). */
const AT_CAP = box(1000n, [500n, 1000n], [2_000, 998_000]);
/** §8.3 point 2: a 1 cent box with a 300 000,00 prize; its return in bps is far above any machine integer. */
const HUGE = box(1n, [0n, 30_000_000n], [500_000, 500_000]);
/** §8.6: the draft at exactly 91.98 %: 10,00; 3 and 13 at 380 200 / 619 800 (boxBps 9 198). */
const DRAFT_9198 = box(1000n, [300n, 1300n], [380_200, 619_800]);
/** A hand-made edition at 92.99 %: 10,00; 3 and 13 at 370 100 / 629 900 (S = 929 900 000, boxBps 9 299). */
const UNDER_9299 = box(1000n, [300n, 1300n], [370_100, 629_900]);
/**
 * A box whose rate is exactly 9 300 and which holds the minimum edge of §8.4 from a 5,00 stake: 100,00; 5,
 * 100, 4 654,65 and 4 654,66 at 73 780 / 926 218 / 1 / 1 (S = 9 300 000 931, boxBps 9 300).
 */
const EDGE_9300 = box(10_000n, [500n, 10_000n, 465_465n, 465_466n], [73_780, 926_218, 1, 1]);

describe('version 3: the box\'s rate (§8.3)', () => {
  it('is the box\'s exact return rounded down to a whole basis point', () => {
    assert.equal(upgradeStepRateBps(WORKED_9636, 3), 9_636);
    assert.equal(upgradeStepRateBps(FLOOR_9400, 3), 9_400);
    assert.equal(upgradeStepRateBps(BOX_9550, 3), 9_550);
    assert.equal(upgradeStepRateBps(EDGE_9300, 3), 9_300);
  });

  it('is rounded down: the box at 93.000375 % gets 9 300, not 9 301', () => {
    assert.equal(upgradeStepRateBps(WORKED_BOX_9300, 3), 9_300);
  });

  it('is capped at 9 990, on the exact integer, before any narrowing', () => {
    assert.equal(upgradeStepRateBps(ABOVE_CAP, 3), 9_990);
    assert.equal(upgradeStepRateBps(AT_CAP, 3), 9_990);
    assert.equal(upgradeStepRateBps(HUGE, 3), 9_990);
  });

  it('refuses a box under 9 300 and a price that is not positive, naming why', () => {
    assert.throws(() => upgradeStepRateBps(DRAFT_9198, 3), /the box returns 9198 bps, under the 9300 bps floor of version 3/);
    assert.throws(() => upgradeStepRateBps(UNDER_9299, 3), /the box returns 9299 bps, under the 9300 bps floor/);
    assert.throws(() => upgradeStepRateBps({ ...WORKED_9636, priceCents: 0n }, 3), /price, which must be above 0 cents, was 0/);
    assert.throws(() => upgradeStepRateBps({ slots: WORKED_9636.slots }, 3), /price, which must be above 0 cents, was undefined/);
  });

  it('is 10 000 on versions 1 and 2, whatever the box returns', () => {
    for (const version of [1, 2]) {
      assert.equal(upgradeStepRateBps(WORKED_9636, version), 10_000);
      assert.equal(upgradeStepRateBps(DRAFT_9198, version), 10_000);
    }
    assert.throws(() => upgradeStepRateBps(WORKED_9636, 5), /version 5 of the upgrade engine is not one this library checks/);
  });
});

describe('version 3: the chance, rounded up (§8.4)', () => {
  it('gives the worked chances at 9 636', () => {
    assert.equal(upgradeChancePpm(2000n, 4500n, 9_636, true), 428_267); // 428 266.67
    assert.equal(upgradeChancePpm(1200n, 2000n, 9_636, true), 578_160); // exact
    assert.equal(stepChanceText(428_267), '42.82%');
  });

  it('gives the worked chances at 9 300', () => {
    assert.equal(upgradeChancePpm(1000n, 2000n, 9_300, true), 465_000);
    assert.equal(upgradeChancePpm(700n, 900n, 9_300, true), 723_334); // 723 333.3; rounded down it is 723 333
    assert.equal(upgradeChancePpm(700n, 900n, 9_300, false), 723_333);
    assert.equal(upgradeChancePpm(500n, 400_000n, 9_300, true), 1_163); // 1 162.5
    assert.equal(upgradeChancePpm(500n, 465_465n, 9_300, true), 1_000); // 999.001
    assert.equal(upgradeChancePpm(500n, 465_466n, 9_300, true), 999);
    assert.equal(upgradeChancePpm(500n, 50_000n, 9_300, true), 9_300);
    assert.equal(upgradeChancePpm(500n, 50_001n, 9_300, true), 9_300);
    assert.equal(upgradeChancePpm(800n, 8000n, 9_300, true), 93_000);
    assert.equal(upgradeChancePpm(500n, 8000n, 9_300, true), 58_125);
  });

  it('gives the worked chances at the other rates of §8.12', () => {
    assert.equal(upgradeChancePpm(300n, 1300n, 9_400, true), 216_924); // 216 923.08
    assert.equal(upgradeChancePpm(1000n, 2000n, 9_550, true), 477_500);
    assert.equal(upgradeChancePpm(500n, 1000n, 9_990, true), 499_500);
  });

  it('keeps the fair rule of versions 1 and 2 as its default', () => {
    assert.equal(upgradeChancePpm(2000n, 4500n), 444_444);
    assert.equal(upgradeChancePpm(500n, 50_001n), 9_999);
  });

  it('refuses a rate that is not a whole number of basis points from 1 to 10 000', () => {
    assert.throws(() => upgradeChancePpm(500n, 1000n, 0, true), /a step return is an integer in \[1, 10000\] bps, was 0/);
    assert.throws(() => upgradeChancePpm(500n, 1000n, 10_001, true), /was 10001/);
    assert.throws(() => upgradeChancePpm(500n, 1000n, 9_300.5, true), /was 9300.5/);
  });
});

describe('version 3: the targets and the single offer (§8.2, §8.4)', () => {
  it('lists every higher value at the box\'s rate, at 0.1 % or more, rounded up', () => {
    assert.deepEqual(upgradeTargets(WORKED_9636, 0, 3), [
      { targetSlotIndex: 1, chancePpm: 401_500 },
      { targetSlotIndex: 2, chancePpm: 240_900 },
      { targetSlotIndex: 3, chancePpm: 107_067 }, // 107 066.67
      { targetSlotIndex: 4, chancePpm: 24_090 },
    ]);
    assert.deepEqual(upgradeTargets(WORKED_9636, 2, 3), [
      { targetSlotIndex: 3, chancePpm: 428_267 },
      { targetSlotIndex: 4, chancePpm: 96_360 },
    ]);
  });

  it('stops at the minimum edge: 4 654,65 at 1 000 ppm is listed, 4 654,66 at 999 is not', () => {
    assert.deepEqual(upgradeTargets(EDGE_9300, 0, 3), [
      { targetSlotIndex: 1, chancePpm: 46_500 },
      { targetSlotIndex: 2, chancePpm: 1_000 },
    ]);
  });

  it('lists nothing from the top value, at any depth', () => {
    assert.deepEqual(upgradeTargets(WORKED_9636, 4, 3), []);
    assert.equal(upgradeTarget(WORKED_9636, 4, 3), null);
  });

  it('gives a single offer at 0.1 % or more, where versions 1 and 2 need 10 %', () => {
    // 5,00 → 100,00 at 9 300 is 46 500 ppm: the single offer on version 3, under 10 % on version 1.
    assert.deepEqual(upgradeTarget(EDGE_9300, 0, 3), { targetSlotIndex: 1, chancePpm: 46_500 });
    assert.equal(upgradeTarget(EDGE_9300, 0, 1), null);
    // 8,00 → 80,00 at 9 300 is 93 000 ppm: offered on version 3 (D2 B).
    const eightToEighty = box(4000n, [800n, 8000n], [500_000, 500_000]);
    assert.equal(upgradeStepRateBps(eightToEighty, 3), 9_990);
    // 47,31; 8 and 80 at 500 000 each: S = 4 400 000 000, 93.0036 %, so 9 300.
    const at9300 = box(4731n, [800n, 8000n], [500_000, 500_000]);
    assert.equal(upgradeStepRateBps(at9300, 3), 9_300);
    assert.deepEqual(upgradeTarget(at9300, 0, 3), { targetSlotIndex: 1, chancePpm: 93_000 });
    // The single offer at the edge, when 4 654,65 is the next higher value: 1 000 ppm, offered.
    // 10,00; 5 and 4 654,65 at 999 075 / 925: S = 930 092 625, 93.009 %, so 9 300.
    const edgeNext = box(1000n, [500n, 465_465n], [999_075, 925]);
    assert.equal(upgradeStepRateBps(edgeNext, 3), 9_300);
    assert.deepEqual(upgradeTarget(edgeNext, 0, 3), { targetSlotIndex: 1, chancePpm: 1_000 });
  });

  it('refuses every step of a box whose rate cannot be read', () => {
    assert.throws(() => upgradeTargets(DRAFT_9198, 0, 3), /the box returns 9198 bps/);
    assert.throws(() => upgradeTarget(DRAFT_9198, 0, 3), /the box returns 9198 bps/);
    // Versions 1 and 2 do not read the rate, so the same slots still list their fair steps there.
    assert.deepEqual(upgradeTargets(DRAFT_9198, 0, 2), [{ targetSlotIndex: 1, chancePpm: 230_769 }]);
  });
});

describe('version 3: verifying one step', () => {
  const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const COMMITMENT = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd';
  let step: UpgradeStepInput;

  before(async () => {
    // 20,00 → 45,00 on the 9 636 box at 428 267 ppm; nonce 1 of `alice-seed` draws 186 669, which wins.
    step = {
      serverSeedHex: SEED,
      commitmentHex: COMMITMENT,
      clientSeed: 'alice-seed',
      nonce: 1,
      edition: WORKED_9636,
      engineType: UPGRADE_ENGINE_TYPE,
      expected: {
        editionFingerprint: await editionFingerprint(WORKED_9636),
        stakedSlotIndex: 2,
        targetSlotIndex: 3,
        chancePpm: 428_267,
        chanceCompact: '42.82%',
        drawnPpmValue: 186_669,
        outcome: 'won',
        stepNo: 4,
      },
    };
  });

  it('verifies a step numbered 4 at the box\'s rate, and names the rate it used', async () => {
    const report = await verifyUpgradeStep(step);
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.stepRateBps, 9_636);
    assert.deepEqual(report.trace.computedOffer, { targetSlotIndex: 3, chancePpm: 428_267 });
    assert.deepEqual(report.checks.stepNo, { ok: true, expected: `in range 1..${UPGRADE_MAX_CHAIN}`, computed: '4' });
  });

  it('accepts step 29 and refuses step 30: a box of 30 prizes allows at most 29 steps', async () => {
    assert.equal(UPGRADE_MAX_CHAIN, 29);
    const at29 = await verifyUpgradeStep({ ...step, expected: { ...step.expected, stepNo: 29 } });
    assert.equal(at29.status, 'verified', at29.summary);
    const at30 = await verifyUpgradeStep({ ...step, expected: { ...step.expected, stepNo: 30 } });
    assert.equal(at30.firstFailure?.check, 'stepNo');
    assert.deepEqual(at30.checks.stepNo, { ok: false, expected: 'in range 1..29', computed: '30' });
  });

  it('fails the chance of the floor rate, of the fair rule and of rounding down', async () => {
    for (const [chancePpm, chanceCompact] of [[413_334, '41.33%'], [444_444, '44.44%'], [428_266, '42.82%']] as const) {
      const report = await verifyUpgradeStep({ ...step, expected: { ...step.expected, chancePpm, chanceCompact } });
      assert.equal(report.firstFailure?.check, 'upgradeChance', `${chancePpm}`);
      assert.deepEqual(report.checks.upgradeChance, { ok: false, expected: String(chancePpm), computed: '428267' });
    }
  });

  it('fails a target under 0.1 % on the box at 9 300', async () => {
    const edge = { ...step, edition: EDGE_9300 };
    const fp = await editionFingerprint(EDGE_9300);
    const listed = await verifyUpgradeStep({
      ...edge,
      expected: { ...step.expected, editionFingerprint: fp, stakedSlotIndex: 0, targetSlotIndex: 2, chancePpm: 1_000, chanceCompact: '0.10%', outcome: 'lost', stepNo: 1 },
    });
    assert.equal(listed.status, 'verified', listed.summary);
    const under = await verifyUpgradeStep({
      ...edge,
      expected: { ...step.expected, editionFingerprint: fp, stakedSlotIndex: 0, targetSlotIndex: 3, chancePpm: 999, chanceCompact: '< 0.01%', outcome: 'lost', stepNo: 1 },
    });
    assert.equal(under.firstFailure?.check, 'upgradeTarget');
    assert.deepEqual(under.checks.upgradeTarget, { ok: false, expected: '3', computed: 'none: slot 0 cannot step to slot 3' });
  });

  it('fails a step on a box under 9 300, naming the box\'s return, and computes no chance', async () => {
    const under: Edition = { ...UNDER_9299, slots: UNDER_9299.slots };
    const report = await verifyUpgradeStep({
      ...step,
      edition: under,
      expected: { ...step.expected, editionFingerprint: await editionFingerprint(under), stakedSlotIndex: 0, targetSlotIndex: 1, chancePpm: 214_593, chanceCompact: '21.45%' },
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'upgradeChance');
    assert.equal(report.firstFailure?.field, 'edition');
    assert.match(report.firstFailure?.message ?? '', /the box returns 9299 bps, under the 9300 bps floor of version 3/);
    assert.equal(report.trace.stepRateBps, undefined);
    assert.equal(report.trace.computedOffer, undefined);
    assert.deepEqual(
      report.notRun.filter((n) => n.check === 'upgradeTarget' || n.check === 'chanceCompact').map((n) => n.check),
      ['upgradeTarget', 'chanceCompact'],
    );
  });

  it('reads the rule from the edition\'s version: the same slots on version 2 are checked fair', async () => {
    const v2 = { ...WORKED_9636, engineVersion: 2 };
    const report = await verifyUpgradeStep({
      ...step,
      edition: v2,
      expected: { ...step.expected, editionFingerprint: await editionFingerprint(v2), chancePpm: 444_444, chanceCompact: '44.44%', stepNo: 1 },
    });
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.stepRateBps, 10_000);
    const fourth = await verifyUpgradeStep({
      ...step,
      edition: v2,
      expected: { ...step.expected, editionFingerprint: await editionFingerprint(v2), chancePpm: 444_444, chanceCompact: '44.44%', stepNo: 4 },
    });
    assert.deepEqual(fourth.checks.stepNo, { ok: false, expected: 'in range 1..3', computed: '4' });
  });
});

describe('version 3: the console\'s edition check agrees (documentation #968)', () => {
  interface CheckSlot { slotIndex: number; targetSlotIndex: number | null; chancePpm: number | null; noOfferReason: string | null }
  interface Check { rtpBps: number; upgrade: { engineVersion: number; minChancePpm: number; offerMinChancePpm: number; maxSteps: null; stepRtpBps: number | null; slots: CheckSlot[] } }
  function check(name: string): Check {
    return JSON.parse(readFileSync(new URL(`../../test/fixtures/upgrade-contract/${name}.json`, import.meta.url), 'utf8'));
  }

  it('gives the same rate and the same single offer for every slot of the 9 636 box', () => {
    const answer = check('console-edition-check-upgrade-v3');
    assert.equal(answer.upgrade.engineVersion, 3);
    assert.equal(answer.upgrade.minChancePpm, 1_000);
    assert.equal(answer.upgrade.offerMinChancePpm, 1_000);
    assert.equal(answer.upgrade.maxSteps, null);
    assert.equal(upgradeStepRateBps(WORKED_9636, 3), answer.upgrade.stepRtpBps);
    assert.equal(answer.upgrade.slots.length, WORKED_9636.slots.length);
    for (const slot of answer.upgrade.slots) {
      const offer = upgradeTarget(WORKED_9636, slot.slotIndex, 3);
      assert.deepEqual(
        offer,
        slot.targetSlotIndex === null ? null : { targetSlotIndex: slot.targetSlotIndex, chancePpm: slot.chancePpm },
        `slot ${slot.slotIndex}`,
      );
    }
  });

  it('refuses the box under the floor, where the console check names no rate and no step', () => {
    const answer = check('console-edition-check-upgrade-v3-below-floor');
    assert.equal(answer.rtpBps, 9_198);
    assert.equal(answer.upgrade.stepRtpBps, null);
    assert.deepEqual(answer.upgrade.slots, []);
    assert.throws(() => upgradeStepRateBps(DRAFT_9198, 3), new RegExp(`the box returns ${answer.rtpBps} bps`));
  });
});
