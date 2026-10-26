/**
 * Verifying an upgrade step, and an upgrade win through the open check (rng-fairness §4b, §6).
 *
 * The draws use the fixture's own seed and the spec rows `alice-seed` nonces 1 and 2, whose values the
 * platform pins (186 669 and 459 796), on the worked box of KAN-1154 (buy-back 5 / 12 / 30 / 80 EUR). At a
 * chance of 400 000 ppm (12 -> 30 EUR), nonce 1 wins and nonce 2 loses. The step-family vectors from the
 * platform (A2) replace these once they exist.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';

import {
  type Edition,
  type UpgradeStepInput,
  type VerificationInput,
  editionFingerprint,
  UPGRADE_ENGINE_TYPE,
  verify,
  verifyUpgradeStep,
} from '../src/verifier.js';

const SEED = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const COMMITMENT = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd';

const EDITION: Edition = {
  engineId: '00000000-0000-4000-8000-00000000e001',
  engineVersion: 1,
  priceCents: 2000n,
  slots: [
    { slotIndex: 0, probabilityPpm: 319_199, requiredBuyBackValueCents: 500n, requiredMarketValueCents: 600n },
    { slotIndex: 1, probabilityPpm: 470_000, requiredBuyBackValueCents: 1200n, requiredMarketValueCents: 1400n },
    { slotIndex: 2, probabilityPpm: 110_000, requiredBuyBackValueCents: 3000n, requiredMarketValueCents: 3500n },
    { slotIndex: 3, probabilityPpm: 100_801, requiredBuyBackValueCents: 8000n, requiredMarketValueCents: 9000n },
  ],
};

function contract(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../test/fixtures/upgrade-contract/${name}.json`, import.meta.url), 'utf8'));
}

let fingerprint: string;
let wonStep: UpgradeStepInput;
let lostStep: UpgradeStepInput;

before(async () => {
  fingerprint = await editionFingerprint(EDITION);
  wonStep = {
    serverSeedHex: SEED,
    commitmentHex: COMMITMENT,
    clientSeed: 'alice-seed',
    nonce: 1,
    edition: EDITION,
    engineType: UPGRADE_ENGINE_TYPE,
    expected: {
      editionFingerprint: fingerprint,
      stakedSlotIndex: 1,
      targetSlotIndex: 2,
      chancePpm: 400_000,
      drawnPpmValue: 186_669,
      outcome: 'won',
      stepNo: 1,
    },
  };
  lostStep = { ...wonStep, nonce: 2, expected: { ...wonStep.expected, drawnPpmValue: 459_796, outcome: 'lost' } };
});

describe('verifyUpgradeStep', () => {
  it('verifies a won step, every check run', async () => {
    const report = await verifyUpgradeStep(wonStep);
    assert.equal(report.status, 'verified', report.summary);
    assert.deepEqual(Object.keys(report.checks).sort(), [
      'commitment', 'drawnPpmValue', 'editionFingerprint', 'engineType', 'stepNo', 'upgradeChance', 'upgradeOutcome',
      'upgradeTarget',
    ]);
    assert.deepEqual(report.trace.computedOffer, { targetSlotIndex: 2, chancePpm: 400_000 });
    assert.deepEqual(report.trace.cumulative, [
      { slotIndex: 0, probabilityPpm: 400_000, from: 0, to: 400_000 },
      { slotIndex: 1, probabilityPpm: 600_000, from: 400_000, to: 1_000_000 },
    ]);
    assert.match(report.summary, /draws ppm 186669, which wins at a chance of 400000 ppm/);
  });

  it('verifies a lost step exactly like a won one', async () => {
    const report = await verifyUpgradeStep(lostStep);
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.computedOutcome, 'lost');
  });

  it('fails a forged outcome on the derived value, not on the claimed one', async () => {
    const report = await verifyUpgradeStep({ ...lostStep, expected: { ...lostStep.expected, outcome: 'won' } });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'upgradeOutcome');
    assert.equal(report.checks.upgradeOutcome?.computed, 'lost');
  });

  it('fails a forged chance, and still reads the outcome over the fair one', async () => {
    const report = await verifyUpgradeStep({ ...lostStep, expected: { ...lostStep.expected, chancePpm: 500_000 } });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'upgradeChance');
    assert.equal(report.checks.upgradeOutcome?.ok, true);
  });

  it('fails a target that skips a value, and one from the top slot', async () => {
    const skipped = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, targetSlotIndex: 3 } });
    assert.equal(skipped.firstFailure?.check, 'upgradeTarget');
    const top = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, stakedSlotIndex: 3 } });
    assert.equal(top.firstFailure?.check, 'upgradeTarget');
    assert.match(top.checks.upgradeTarget?.computed ?? '', /slot 3 is offered no step/);
  });

  it('fails a box engine and a step past the cap', async () => {
    const box = await verifyUpgradeStep({ ...wonStep, engineType: 'single_draw_weighted_table' });
    assert.equal(box.firstFailure?.check, 'engineType');
    const fourth = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, stepNo: 4 } });
    assert.equal(fourth.firstFailure?.check, 'stepNo');
  });

  it('is pending while the seed is not revealed, and checks the odds anyway', async () => {
    const report = await verifyUpgradeStep({ ...wonStep, serverSeedHex: null });
    assert.equal(report.status, 'pending');
    assert.equal(report.checks.upgradeChance?.ok, true);
    assert.deepEqual(report.notRun.map((n) => n.check).sort(), ['commitment', 'drawnPpmValue', 'upgradeOutcome']);
  });

  it('reports a missing field as invalid, by name', async () => {
    const broken = { ...wonStep, expected: { ...wonStep.expected, outcome: undefined } } as unknown as UpgradeStepInput;
    const report = await verifyUpgradeStep(broken);
    assert.equal(report.status, 'invalid');
    assert.match(report.invalid?.message ?? '', /expected\.outcome/);
  });
});

describe('verify on an upgrade win', () => {
  let upgradeWin: VerificationInput;
  before(() => {
    upgradeWin = {
      serverSeedHex: SEED,
      commitmentHex: COMMITMENT,
      clientSeed: 'alice-seed',
      nonce: 1,
      edition: EDITION,
      gameKind: 'upgrade',
      expected: {
        editionFingerprint: fingerprint,
        drawnPpmValue: 186_669,
        drawnSlotIndex: 2,
        upgradeStepId: '9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e01',
        stepChancePpm: 400_000,
        stepOutcome: 'won',
      },
    };
  });

  it('reads the slot over the step table, never the box table', async () => {
    // On the box table, 186 669 is slot 0. The win holds slot 2 through the step.
    const report = await verify(upgradeWin);
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.computedSlotIndex, 2);
    assert.equal(report.trace.cumulative?.length, 2);
    assert.ok(report.caveats.some((c) => c.includes('step 9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e01')));
  });

  it('fails the same win read as a box open', async () => {
    const { gameKind: _kind, ...asBoxOpen } = upgradeWin;
    const report = await verify(asBoxOpen);
    assert.equal(report.firstFailure?.check, 'drawnSlotIndex');
    assert.equal(report.checks.drawnSlotIndex?.computed, '0');
  });

  it('fails a win whose step value loses, and a chance that is no fair step into the slot', async () => {
    const lostValue = await verify({ ...upgradeWin, nonce: 2, expected: { ...upgradeWin.expected, drawnPpmValue: 459_796 } });
    assert.equal(lostValue.firstFailure?.check, 'drawnSlotIndex');
    assert.equal(lostValue.checks.drawnSlotIndex?.computed, 'step lost');
    const unfair = await verify({ ...upgradeWin, expected: { ...upgradeWin.expected, stepChancePpm: 500_000 } });
    assert.match(unfair.checks.drawnSlotIndex?.computed ?? '', /no step of this edition reaches slot 2 at 500000 ppm/);
  });

  it('refuses an upgrade win without its step facts', async () => {
    const { stepChancePpm: _chance, ...withoutChance } = upgradeWin.expected;
    const report = await verify({ ...upgradeWin, expected: withoutChance });
    assert.equal(report.status, 'invalid');
    assert.match(report.invalid?.message ?? '', /expected\.stepChancePpm/);
  });
});

describe('the field names are the published contract (PR-0 draft)', () => {
  it('the step answer carries every field the step input reads', () => {
    for (const name of ['verify-upgrade-step-won', 'verify-upgrade-step-lost']) {
      const answer = contract(name);
      for (const key of ['engineType', 'nonce', 'editionFingerprint', ...Object.keys(wonStep.expected)]) {
        assert.ok(key in answer, `${name} has no ${key}`);
      }
    }
  });

  it('the upgraded open answer carries the mark and the step facts', () => {
    const answer = contract('verify-open-upgrade-win');
    assert.equal(answer.gameKind, 'upgrade');
    for (const key of ['upgradeStepId', 'stepChancePpm', 'stepOutcome', 'drawnPpmValue', 'drawnSlotIndex']) {
      assert.ok(key in answer, `the open answer has no ${key}`);
    }
  });
});
