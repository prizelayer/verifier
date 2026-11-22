/**
 * The demo rule set of 17 and 18 November 2026 (KAN-1751 plan v1.2 D3 A): a step drawn on dev at 93 % on version 1
 * or 2 verifies under it and fails under the default rule; a fair step fails under it; the library takes it
 * only as its own object; and the default path never uses it.
 * Refs: KAN-1751, KAN-1685
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  DEMO_RULES_2026_11_17,
  UPGRADE_ENGINE_TYPE,
  UPGRADE_RULES,
  editionFingerprint,
  verify,
  verifyUpgradeStep,
  type Edition,
  type UpgradeStepInput,
  type UpgradeStepOptions,
  type VerificationInput,
} from '../src/verifier.js';

const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const COMMITMENT = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd';

function edition(engineVersion: number): Edition {
  return {
    engineId: '00000000-0000-4000-8000-00000000d117',
    engineVersion,
    priceCents: 2000n,
    slots: [
      { slotIndex: 0, probabilityPpm: 319_199, requiredBuyBackValueCents: 500n, requiredMarketValueCents: 600n },
      { slotIndex: 1, probabilityPpm: 470_000, requiredBuyBackValueCents: 1200n, requiredMarketValueCents: 1400n },
      { slotIndex: 2, probabilityPpm: 110_000, requiredBuyBackValueCents: 3000n, requiredMarketValueCents: 3500n },
      { slotIndex: 3, probabilityPpm: 100_801, requiredBuyBackValueCents: 8000n, requiredMarketValueCents: 9000n },
    ],
  };
}

async function step(
  engineVersion: number,
  targetSlotIndex: number,
  chancePpm: number,
  chanceCompact: string,
  outcome: 'won' | 'lost',
): Promise<UpgradeStepInput> {
  const e = edition(engineVersion);
  return {
    serverSeedHex: SEED,
    commitmentHex: COMMITMENT,
    clientSeed: 'alice-seed',
    nonce: 1,
    edition: e,
    engineType: UPGRADE_ENGINE_TYPE,
    expected: {
      editionFingerprint: await editionFingerprint(e),
      stakedSlotIndex: 1,
      targetSlotIndex,
      chancePpm,
      chanceCompact,
      // Nonce 1 of this seed pair draws 186 669.
      drawnPpmValue: 186_669,
      outcome,
      stepNo: 1,
    },
  };
}

const DEMO: UpgradeStepOptions = { demoRules: DEMO_RULES_2026_11_17 };
let v1At93: UpgradeStepInput;
let v1Fair: UpgradeStepInput;
let v2At93: UpgradeStepInput;

before(async () => {
  // 12 → 30 EUR: 0.93 · 400 000 = 372 000 on version 1; 186 669 is under it, so won.
  v1At93 = await step(1, 2, 372_000, '37.20%', 'won');
  v1Fair = await step(1, 2, 400_000, '40.00%', 'won');
  // 12 → 80 EUR on version 2, a jump: 0.93 · 150 000 = 139 500; 186 669 is above it, so lost.
  v2At93 = await step(2, 3, 139_500, '13.95%', 'lost');
});

describe('the demo rule set of 17 and 18 November 2026', () => {
  it('is versions 1 and 2 at 9 300, each otherwise its default rule, and frozen', () => {
    assert.equal(DEMO_RULES_2026_11_17.name, 'DEMO_RULES_2026_11_17');
    assert.deepEqual(
      DEMO_RULES_2026_11_17.rules,
      UPGRADE_RULES.filter((r) => r.engineVersion <= 2).map((r) => ({ ...r, stepRtpBps: 9_300 })),
    );
    assert.ok(Object.isFrozen(DEMO_RULES_2026_11_17));
    assert.ok(Object.isFrozen(DEMO_RULES_2026_11_17.rules));
    for (const rule of DEMO_RULES_2026_11_17.rules) assert.ok(Object.isFrozen(rule));
    // The default table is untouched: versions 1 and 2 stay fair.
    assert.deepEqual(UPGRADE_RULES.filter((r) => r.engineVersion <= 2).map((r) => r.stepRtpBps), [10_000, 10_000]);
  });

  it('verifies a version 1 step at 93 % under it, and names itself in the report', async () => {
    const report = await verifyUpgradeStep(v1At93, DEMO);
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.ruleSet, 'DEMO_RULES_2026_11_17');
    assert.equal(report.trace.stepRateBps, 9_300);
    assert.ok(report.caveats.some((c) => c.startsWith('Checked under the demo rules of 17 and 18 November 2026')));
  });

  it('verifies a version 2 jump at 93 % under it', async () => {
    const report = await verifyUpgradeStep(v2At93, DEMO);
    assert.equal(report.status, 'verified', report.summary);
    assert.deepEqual(report.trace.computedOffer, { targetSlotIndex: 3, chancePpm: 139_500 });
  });

  it('fails the same steps on the default path, which never uses it', async () => {
    for (const input of [v1At93, v2At93]) {
      const report = await verifyUpgradeStep(input);
      assert.equal(report.status, 'failed', report.summary);
      assert.equal(report.firstFailure?.check, 'upgradeChance');
      assert.equal(report.trace.ruleSet, undefined);
      assert.equal(report.trace.stepRateBps, 10_000);
      assert.ok(!report.caveats.some((c) => c.includes('demo rules')));
    }
  });

  it('fails a fair step under it: a listed step is checked at 93 %, not at 100 %', async () => {
    const report = await verifyUpgradeStep(v1Fair, DEMO);
    assert.equal(report.status, 'failed', report.summary);
    assert.equal(report.firstFailure?.check, 'upgradeChance');
    assert.equal((await verifyUpgradeStep(v1Fair)).status, 'verified');
  });

  it('is taken only as the library\'s own object, never a look-alike', async () => {
    const copies = [
      { ...DEMO_RULES_2026_11_17 },
      structuredClone(DEMO_RULES_2026_11_17),
      { name: 'DEMO_RULES_2026_11_17', rules: [{ ...DEMO_RULES_2026_11_17.rules[0], stepRtpBps: 5_000 }] },
    ];
    for (const copy of copies) {
      const report = await verifyUpgradeStep(v1At93, { demoRules: copy as typeof DEMO_RULES_2026_11_17 });
      assert.equal(report.status, 'invalid');
      assert.match(report.summary, /its own DEMO_RULES_2026_11_17/);
    }
  });

  it('has no version 3: a version 3 step under it fails on the version', async () => {
    const report = await verifyUpgradeStep(await step(3, 2, 413_280, '41.32%', 'won'), DEMO);
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'engineVersion');
    assert.equal(report.checks.engineVersion?.expected, '1 or 2');
  });
});

describe('the demo rule set on an upgraded win', () => {
  async function win(chancePpm: number, chanceCompact: string): Promise<VerificationInput> {
    const e = edition(1);
    return {
      serverSeedHex: SEED,
      commitmentHex: COMMITMENT,
      clientSeed: 'alice-seed',
      nonce: 1,
      edition: e,
      gameKind: 'upgrade',
      expected: {
        editionFingerprint: await editionFingerprint(e),
        drawnPpmValue: 186_669,
        drawnSlotIndex: 2,
        upgradeStepId: '9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e01',
        stakedSlotIndex: 1,
        stepChancePpm: chancePpm,
        stepChanceCompact: chanceCompact,
        stepOutcome: 'won',
      },
    };
  }

  it('verifies the win of a step at 93 % under it, and names itself', async () => {
    const report = await verify(await win(372_000, '37.20%'), DEMO);
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.computedSlotIndex, 2);
    assert.equal(report.trace.ruleSet, 'DEMO_RULES_2026_11_17');
    assert.ok(report.caveats.some((c) => c.startsWith('Checked under the demo rules of 17 and 18 November 2026')));
  });

  it('fails the same win on the default path, and a fair win under it', async () => {
    const atDefault = await verify(await win(372_000, '37.20%'));
    assert.equal(atDefault.status, 'failed', atDefault.summary);
    assert.equal(atDefault.firstFailure?.check, 'drawnSlotIndex');
    assert.equal(atDefault.trace.ruleSet, undefined);
    const fairUnderDemo = await verify(await win(400_000, '40.00%'), DEMO);
    assert.equal(fairUnderDemo.status, 'failed', fairUnderDemo.summary);
    assert.equal((await verify(await win(400_000, '40.00%'))).status, 'verified');
  });

  it('is taken only as the library\'s own object on a win too', async () => {
    const report = await verify(await win(372_000, '37.20%'), { demoRules: { ...DEMO_RULES_2026_11_17 } as typeof DEMO_RULES_2026_11_17 });
    assert.equal(report.status, 'invalid');
    assert.match(report.summary, /its own DEMO_RULES_2026_11_17/);
  });
});
