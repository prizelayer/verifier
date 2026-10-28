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
  type UpgradeStepCheckName,
  type UpgradeStepInput,
  type VerificationInput,
  UPGRADE_STEP_CHECK_NAMES,
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
/** From slot 0 (5 EUR) to slot 1 (12 EUR): 416 666 ppm, a chance with a remainder. Nonce 1 (186 669) wins. */
const REMAINDER = {
  stakedSlotIndex: 0,
  targetSlotIndex: 1,
  chancePpm: 416_666,
  drawnPpmValue: 186_669,
  outcome: 'won' as const,
  stepNo: 1,
};
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
      chanceCompact: '40.00%',
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
      'chanceCompact', 'commitment', 'drawnPpmValue', 'editionFingerprint', 'engineType', 'engineVersion', 'stepNo',
      'upgradeChance', 'upgradeOutcome', 'upgradeTarget',
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
    assert.equal(fourth.checks.stepNo?.expected, 'in range 1..3');
  });

  it('verifies a fair third step: the cap allows step 1 to 3', async () => {
    const third = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, stepNo: 3 } });
    assert.equal(third.status, 'verified', third.summary);
    assert.ok(third.caveats.some((c) => c.includes("The step number is the platform's claim")));
  });

  it('fails an edition on another version of the upgrade engine, even with its own true fingerprint', async () => {
    const v2: Edition = { ...EDITION, engineVersion: 2 };
    const report = await verifyUpgradeStep({
      ...wonStep,
      edition: v2,
      expected: { ...wonStep.expected, editionFingerprint: await editionFingerprint(v2) },
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'engineVersion');
    assert.equal(report.checks.editionFingerprint?.ok, true);
    assert.equal(report.checks.engineVersion?.computed, '2');
  });

  // MUST-1 of the review of #15: each core check fails on its own forged input.
  it('fails a revealed seed that is not the committed one', async () => {
    const report = await verifyUpgradeStep({ ...wonStep, commitmentHex: 'ab'.repeat(32) });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'commitment');
  });

  it('fails a claimed fingerprint that is not the edition\'s', async () => {
    const report = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, editionFingerprint: 'cd'.repeat(32) } });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'editionFingerprint');
  });

  it('fails an edition whose buy-back values changed after its fingerprint was published', async () => {
    // Slot 2 worth 2 400 instead of 3 000: the chance from slot 1 would be 500 000 ppm, under a published
    // fingerprint that binds 3 000.
    const changed: Edition = {
      ...EDITION,
      slots: EDITION.slots.map((slot) => (slot.slotIndex === 2 ? { ...slot, requiredBuyBackValueCents: 2400n } : slot)),
    };
    const report = await verifyUpgradeStep({ ...wonStep, edition: changed });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'editionFingerprint');
  });

  it('fails a misreported drawn value even when its outcome is right', async () => {
    // 186 670 still wins at 400 000 ppm: only the value itself is wrong.
    const report = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, drawnPpmValue: 186_670 } });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'drawnPpmValue');
    assert.equal(report.checks.upgradeOutcome?.ok, true);
  });

  // E1b (cto 24607 ruling): the string a player reads must be the contract's floor of the FAIR chance.
  it('verifies the string a player reads when it is the floor of a chance with a remainder', async () => {
    const report = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, ...REMAINDER, chanceCompact: '41.66%' } });
    assert.equal(report.status, 'verified', report.summary);
    assert.deepEqual(report.checks.chanceCompact, { ok: true, expected: '41.66%', computed: '41.66%' });
  });

  it('fails a rounded-up string on the right chance: chanceCompact fails, upgradeChance still matches', async () => {
    const report = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, ...REMAINDER, chanceCompact: '41.67%' } });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'chanceCompact');
    assert.equal(report.checks.upgradeChance?.ok, true);
    assert.equal(report.checks.chanceCompact?.computed, '41.66%');
  });

  // Every check the library makes fails on its own forged input, first. The guard test below reddens when
  // the library gains a check this table does not forge (cto 24607 ruling, condition 2).
  const FORGED: Record<UpgradeStepCheckName, () => Promise<UpgradeStepInput>> = {
    commitment: async () => ({ ...wonStep, commitmentHex: 'ab'.repeat(32) }),
    editionFingerprint: async () => ({ ...wonStep, expected: { ...wonStep.expected, editionFingerprint: 'cd'.repeat(32) } }),
    engineType: async () => ({ ...wonStep, engineType: 'single_draw_weighted_table' }),
    engineVersion: async () => {
      const v2: Edition = { ...EDITION, engineVersion: 2 };
      return { ...wonStep, edition: v2, expected: { ...wonStep.expected, editionFingerprint: await editionFingerprint(v2) } };
    },
    upgradeTarget: async () => ({ ...wonStep, expected: { ...wonStep.expected, targetSlotIndex: 3 } }),
    upgradeChance: async () => ({ ...wonStep, expected: { ...wonStep.expected, chancePpm: 500_000 } }),
    chanceCompact: async () => ({ ...wonStep, expected: { ...wonStep.expected, chanceCompact: '41.00%' } }),
    stepNo: async () => ({ ...wonStep, expected: { ...wonStep.expected, stepNo: 4 } }),
    drawnPpmValue: async () => ({ ...wonStep, expected: { ...wonStep.expected, drawnPpmValue: 186_670 } }),
    upgradeOutcome: async () => ({ ...wonStep, expected: { ...wonStep.expected, outcome: 'lost' } }),
  };

  it('has a forged input for every step check the library makes', () => {
    assert.deepEqual(Object.keys(FORGED).sort(), [...UPGRADE_STEP_CHECK_NAMES].sort());
  });

  for (const name of UPGRADE_STEP_CHECK_NAMES) {
    it(`fails first on ${name} when only ${name} is forged`, async () => {
      const forge = FORGED[name];
      assert.ok(forge, `no forged input for ${name}`);
      const report = await verifyUpgradeStep(await forge());
      assert.equal(report.status, 'failed', report.summary);
      assert.equal(report.firstFailure?.check, name);
    });
  }

  it('is pending while the seed is not revealed, and checks the odds anyway', async () => {
    const report = await verifyUpgradeStep({ ...wonStep, serverSeedHex: null });
    assert.equal(report.status, 'pending');
    assert.equal(report.checks.upgradeChance?.ok, true);
    assert.deepEqual(report.notRun.map((n) => n.check).sort(), ['commitment', 'drawnPpmValue', 'upgradeOutcome']);
  });

  it('refuses a missing or non-string chanceCompact as invalid, by name', async () => {
    for (const bad of [undefined, null, 40]) {
      const input = { ...wonStep, expected: { ...wonStep.expected, chanceCompact: bad } } as unknown as UpgradeStepInput;
      const report = await verifyUpgradeStep(input);
      assert.equal(report.status, 'invalid', `chanceCompact ${String(bad)}`);
      assert.match(report.invalid?.message ?? '', /expected\.chanceCompact/);
    }
  });

  it('compares chanceCompact exactly: a space before or after the right string fails', async () => {
    for (const spaced of [' 40.00%', '40.00% ']) {
      const report = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, chanceCompact: spaced } });
      assert.equal(report.status, 'failed', JSON.stringify(spaced));
      assert.equal(report.firstFailure?.check, 'chanceCompact');
    }
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
        stakedSlotIndex: 1,
        stepChancePpm: 400_000,
        stepChanceCompact: '40.00%',
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
    assert.ok(report.caveats.some((c) => c.includes('from slot 1') && c.includes('step 9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e01')));
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
    assert.match(unfair.checks.drawnSlotIndex?.computed ?? '', /the step from slot 1 has a chance of 400000 ppm, not 500000/);
  });

  it('fails a win whose staked slot leads to another target', async () => {
    // From slot 0 the step goes to slot 1 at 416 666 ppm, so neither the chance nor the slot fits.
    const wrongSlot = await verify({ ...upgradeWin, expected: { ...upgradeWin.expected, stakedSlotIndex: 0 } });
    assert.equal(wrongSlot.firstFailure?.check, 'drawnSlotIndex');
    const fromTop = await verify({ ...upgradeWin, expected: { ...upgradeWin.expected, stakedSlotIndex: 3 } });
    assert.match(fromTop.checks.drawnSlotIndex?.computed ?? '', /slot 3 is offered no step/);
  });

  it('reads the target by value order, never slot + 1', async () => {
    // Slot order is not value order: from slot 1 (5 EUR) the next value up is slot 3 (12 EUR), 416 666 ppm.
    const shuffled: Edition = {
      ...EDITION,
      slots: [
        { slotIndex: 0, probabilityPpm: 300_000, requiredBuyBackValueCents: 3000n, requiredMarketValueCents: 3500n },
        { slotIndex: 1, probabilityPpm: 400_000, requiredBuyBackValueCents: 500n, requiredMarketValueCents: 600n },
        { slotIndex: 2, probabilityPpm: 100_000, requiredBuyBackValueCents: 8000n, requiredMarketValueCents: 9000n },
        { slotIndex: 3, probabilityPpm: 200_000, requiredBuyBackValueCents: 1200n, requiredMarketValueCents: 1400n },
      ],
    };
    const report = await verify({
      ...upgradeWin,
      edition: shuffled,
      expected: {
        ...upgradeWin.expected,
        editionFingerprint: await editionFingerprint(shuffled),
        drawnSlotIndex: 3,
        stakedSlotIndex: 1,
        stepChancePpm: 416_666,
        stepChanceCompact: '41.66%',
      },
    });
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.computedSlotIndex, 3);
  });

  it('says the cap and the engine are checked on the step page', async () => {
    const report = await verify(upgradeWin);
    assert.ok(report.caveats.some((c) => c.includes('the cap on steps and the engine type and version')));
  });

  it('refuses an upgrade win without its step facts', async () => {
    const { stepChancePpm: _chance, ...withoutChance } = upgradeWin.expected;
    const report = await verify({ ...upgradeWin, expected: withoutChance });
    assert.equal(report.status, 'invalid');
    assert.match(report.invalid?.message ?? '', /expected\.stepChancePpm/);
  });

  // E1b, SHOULD-2 of the review of #17 (eleonora 24614, A): the chance text shown with an upgrade win is
  // checked inside drawnSlotIndex, against the text of the FAIR chance.
  it('refuses an upgrade win whose shown chance text is missing or not a string', async () => {
    for (const bad of [undefined, null, 40]) {
      const input = { ...upgradeWin, expected: { ...upgradeWin.expected, stepChanceCompact: bad } } as unknown as VerificationInput;
      const report = await verify(input);
      assert.equal(report.status, 'invalid', `stepChanceCompact ${String(bad)}`);
      assert.match(report.invalid?.message ?? '', /expected\.stepChanceCompact/);
    }
  });

  it('fails an upgrade win shown at a chance text that is not the fair one, naming both texts', async () => {
    for (const shown of ['41.00%', '40%', ' 40.00%']) {
      const report = await verify({ ...upgradeWin, expected: { ...upgradeWin.expected, stepChanceCompact: shown } });
      assert.equal(report.status, 'failed', JSON.stringify(shown));
      assert.equal(report.firstFailure?.check, 'drawnSlotIndex');
      assert.deepEqual(report.checks.drawnSlotIndex, { ok: false, expected: `chance shown ${shown}`, computed: 'fair chance 40.00%' });
    }
  });

  it('a box open needs no shown step chance', async () => {
    const { stepChanceCompact: _text, ...withoutText } = upgradeWin.expected;
    const report = await verify({ ...upgradeWin, gameKind: 'box_open', expected: withoutText });
    assert.notEqual(report.status, 'invalid', report.summary);
  });
});

describe('the field names are the published contract (PR-0 draft)', () => {
  it('the step answer carries every field the step input reads', () => {
    for (const name of ['verify-upgrade-step-won', 'verify-upgrade-step-lost']) {
      const answer = contract(name);
      for (const key of ['engineType', 'nonce', 'editionFingerprint', 'chanceCompact', ...Object.keys(wonStep.expected)]) {
        assert.ok(key in answer, `${name} has no ${key}`);
      }
    }
  });

  it('the upgraded open answer carries the mark and the step facts', () => {
    const answer = contract('verify-open-upgrade-win');
    assert.equal(answer.gameKind, 'upgrade');
    for (const key of ['upgradeStepId', 'stakedSlotIndex', 'stepChancePpm', 'stepChanceCompact', 'stepOutcome', 'drawnPpmValue', 'drawnSlotIndex']) {
      assert.ok(key in answer, `the open answer has no ${key}`);
    }
  });
});
