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
    // Version 3: versions 1 and 2 are both checked since KAN-1567.
    const v3: Edition = { ...EDITION, engineVersion: 3 };
    const report = await verifyUpgradeStep({
      ...wonStep,
      edition: v3,
      expected: { ...wonStep.expected, editionFingerprint: await editionFingerprint(v3) },
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'engineVersion');
    assert.equal(report.checks.editionFingerprint?.ok, true);
    assert.equal(report.checks.engineVersion?.computed, '3');
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
      const v3: Edition = { ...EDITION, engineVersion: 3 };
      return { ...wonStep, edition: v3, expected: { ...wonStep.expected, editionFingerprint: await editionFingerprint(v3) } };
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

  // Version 1's report words, as literals copied from the published library (c2a8ca4): the version table
  // writes them again through new code, so a test that compared the code with itself could not see an edit.
  it('keeps version 1\'s report words byte for byte', async () => {
    const won = await verify(upgradeWin);
    assert.ok(won.caveats.includes(
      'This win was made by an upgrade step from slot 1. This run checks the step\'s draw, its fair chance and ' +
        'its target over the step\'s own table. That the staked win really held slot 1 is shown on the step\'s ' +
        'own page (step 9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e01), and so are the cap on steps and the engine type ' +
        'and version, which this run does not check.',
    ), won.caveats.join('\n'));
    const top = await verifyUpgradeStep({ ...wonStep, expected: { ...wonStep.expected, stakedSlotIndex: 3 } });
    assert.deepEqual(top.checks.engineVersion, { ok: true, expected: '1', computed: '1' });
    assert.deepEqual(top.checks.upgradeTarget, { ok: false, expected: '2', computed: 'none: slot 3 is offered no step' });
    assert.deepEqual(
      top.notRun.filter((n) => n.check === 'upgradeChance' || n.check === 'chanceCompact').map((n) => n.reason),
      ['the edition offers no step from the staked slot', 'the edition offers no step from the staked slot'],
    );
    const locked = await verify({
      ...upgradeWin,
      serverSeedHex: null,
      expected: { ...upgradeWin.expected, stakedSlotIndex: 3 },
    });
    assert.equal(locked.checks.drawnSlotIndex?.computed, 'fair chance none, slot 3 is offered no step');
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

  // E2 N-1 (owner ruling, KAN-1154): the shown chance needs no seed, so it is checked while the seed is still locked.
  it('fails a wrong shown chance while the seed is locked, naming both texts', async () => {
    const report = await verify({ ...upgradeWin, serverSeedHex: null, expected: { ...upgradeWin.expected, stepChanceCompact: '41.00%' } });
    assert.equal(report.status, 'failed', report.summary);
    assert.equal(report.firstFailure?.check, 'drawnSlotIndex');
    assert.deepEqual(report.checks.drawnSlotIndex, { ok: false, expected: 'chance shown 41.00%', computed: 'fair chance 40.00%' });
  });

  it('stays pending with the right shown chance while the seed is locked', async () => {
    const report = await verify({ ...upgradeWin, serverSeedHex: null });
    assert.equal(report.status, 'pending', report.summary);
    assert.equal(report.checks.drawnSlotIndex, undefined);
    assert.ok(report.notRun.some((n) => n.check === 'drawnSlotIndex'));
  });

  it('takes the fair chance from the edition and the staked slot, never from the claimed ppm', async () => {
    // The claim says 416 666 ppm and shows its text "41.66%"; the edition says 400 000 from slot 1.
    const report = await verify({
      ...upgradeWin,
      serverSeedHex: null,
      expected: { ...upgradeWin.expected, stepChancePpm: 416_666, stepChanceCompact: '41.66%' },
    });
    assert.equal(report.status, 'failed', report.summary);
    assert.deepEqual(report.checks.drawnSlotIndex, { ok: false, expected: 'chance shown 41.66%', computed: 'fair chance 40.00%' });
  });

  // The other seed-free facts of a locked upgrade win fail too (owner ruling, KAN-1154): none needs the seed.
  it('fails a locked upgrade win whose staked slot is offered no step', async () => {
    // Slot 3 holds the top buy-back value of the box, so no step is offered from it.
    const report = await verify({
      ...upgradeWin,
      serverSeedHex: null,
      expected: { ...upgradeWin.expected, stakedSlotIndex: 3, stepChanceCompact: '99.00%' },
    });
    assert.equal(report.status, 'failed', report.summary);
    assert.equal(report.firstFailure?.check, 'drawnSlotIndex');
    assert.deepEqual(report.checks.drawnSlotIndex, {
      ok: false,
      expected: 'chance shown 99.00%',
      computed: 'fair chance none, slot 3 is offered no step',
    });
  });

  it('fails a locked upgrade win whose staked slot is not in the box', async () => {
    const report = await verify({
      ...upgradeWin,
      serverSeedHex: null,
      expected: { ...upgradeWin.expected, stakedSlotIndex: 9, stepChanceCompact: '99.00%' },
    });
    assert.equal(report.status, 'failed', report.summary);
    assert.deepEqual(report.checks.drawnSlotIndex, {
      ok: false,
      expected: 'chance shown 99.00%',
      computed: 'fair chance none, slot 9 is not in the box',
    });
  });

  it('fails a locked upgrade win whose recorded chance is not the fair one, under the fair text', async () => {
    const report = await verify({
      ...upgradeWin,
      serverSeedHex: null,
      expected: { ...upgradeWin.expected, stepChancePpm: 416_666, stepChanceCompact: '40.00%' },
    });
    assert.equal(report.status, 'failed', report.summary);
    assert.deepEqual(report.checks.drawnSlotIndex, {
      ok: false,
      expected: 'chance recorded 416666 ppm',
      computed: 'fair chance 400000 ppm',
    });
  });

  it('fails a locked upgrade win whose shown text only differs by a trailing space', async () => {
    const report = await verify({ ...upgradeWin, serverSeedHex: null, expected: { ...upgradeWin.expected, stepChanceCompact: '40.00% ' } });
    assert.equal(report.status, 'failed', report.summary);
    assert.deepEqual(report.checks.drawnSlotIndex, { ok: false, expected: 'chance shown 40.00% ', computed: 'fair chance 40.00%' });
  });

  it('draws no box range for a locked upgrade win, and the step table with its outcome once revealed', async () => {
    const locked = await verify({ ...upgradeWin, serverSeedHex: null });
    assert.equal(locked.trace.cumulative, undefined);
    assert.equal(locked.trace.computedStepOutcome, undefined);
    const revealed = await verify(upgradeWin);
    assert.equal(revealed.trace.computedStepOutcome, 'won');
    assert.deepEqual(
      revealed.trace.cumulative?.map((r) => r.slotIndex),
      [0, 1],
    );
  });

  it('refuses a locked upgrade win without its edition or its staked slot, never pending', async () => {
    const { stakedSlotIndex: _slot, ...withoutSlot } = upgradeWin.expected;
    const noSlot = await verify({ ...upgradeWin, serverSeedHex: null, expected: withoutSlot });
    assert.equal(noSlot.status, 'invalid');
    assert.match(noSlot.invalid?.message ?? '', /expected\.stakedSlotIndex/);
    const noEdition = await verify({ ...upgradeWin, serverSeedHex: null, edition: undefined } as unknown as VerificationInput);
    assert.equal(noEdition.status, 'invalid');
    assert.match(noEdition.invalid?.message ?? '', /edition/);
  });

  it('a box open needs no shown step chance', async () => {
    const { stepChanceCompact: _text, ...withoutText } = upgradeWin.expected;
    const report = await verify({ ...upgradeWin, gameKind: 'box_open', expected: withoutText });
    assert.notEqual(report.status, 'invalid', report.summary);
  });
});

/**
 * Version 2 of the upgrade engine (KAN-1567, ADR-KAN-1154 amendment 4): a step may name any strictly higher
 * value of the box at 1 % or more. The worked box on version 2, the same seed pair: nonce 5 draws 133 803
 * (this library's derive, which the draw family pins), under the 166 666 ppm of 5 -> 30 EUR, so the jump
 * from slot 0 to slot 2 wins; nonce 1 (186 669) loses it.
 */
describe('version 2: a jump', () => {
  const EDITION_V2: Edition = { ...EDITION, engineVersion: 2 };
  /** 1 -> 100 EUR is exactly 10 000 ppm; 1 -> 100.01 EUR is 9 999 ppm. */
  const EDGES_V2: Edition = {
    ...EDITION_V2,
    slots: [
      { slotIndex: 0, probabilityPpm: 980_000, requiredBuyBackValueCents: 100n, requiredMarketValueCents: 100n },
      { slotIndex: 1, probabilityPpm: 10_000, requiredBuyBackValueCents: 10_001n, requiredMarketValueCents: 10_001n },
      { slotIndex: 2, probabilityPpm: 10_000, requiredBuyBackValueCents: 10_000n, requiredMarketValueCents: 10_000n },
    ],
  };
  let jump: UpgradeStepInput;
  let jumpWin: VerificationInput;
  let edgesFingerprint: string;

  before(async () => {
    const v2Fingerprint = await editionFingerprint(EDITION_V2);
    edgesFingerprint = await editionFingerprint(EDGES_V2);
    jump = {
      ...wonStep,
      nonce: 5,
      edition: EDITION_V2,
      expected: {
        editionFingerprint: v2Fingerprint,
        stakedSlotIndex: 0,
        targetSlotIndex: 2,
        chancePpm: 166_666,
        chanceCompact: '16.66%',
        drawnPpmValue: 133_803,
        outcome: 'won',
        stepNo: 1,
      },
    };
    jumpWin = {
      serverSeedHex: SEED,
      commitmentHex: COMMITMENT,
      clientSeed: 'alice-seed',
      nonce: 5,
      edition: EDITION_V2,
      gameKind: 'upgrade',
      expected: {
        editionFingerprint: v2Fingerprint,
        drawnPpmValue: 133_803,
        drawnSlotIndex: 2,
        upgradeStepId: '9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e11',
        stakedSlotIndex: 0,
        stepChancePpm: 166_666,
        stepChanceCompact: '16.66%',
        stepOutcome: 'won',
      },
    };
  });

  it('verifies a won jump past the next value, every check run', async () => {
    const report = await verifyUpgradeStep(jump);
    assert.equal(report.status, 'verified', report.summary);
    assert.deepEqual(report.notRun, []);
    assert.deepEqual(report.checks.engineVersion, { ok: true, expected: '2', computed: '2' });
    assert.deepEqual(report.checks.upgradeTarget, { ok: true, expected: '2', computed: '2' });
    assert.deepEqual(report.trace.computedOffer, { targetSlotIndex: 2, chancePpm: 166_666 });
    assert.equal(report.trace.computedOutcome, 'won');
  });

  it('verifies a lost jump exactly like a won one', async () => {
    const report = await verifyUpgradeStep({ ...jump, nonce: 1, expected: { ...jump.expected, drawnPpmValue: 186_669, outcome: 'lost' } });
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.computedOutcome, 'lost');
  });

  it('verifies the next value up on version 2 too', async () => {
    const report = await verifyUpgradeStep({ ...wonStep, edition: EDITION_V2, expected: { ...wonStep.expected, editionFingerprint: jump.expected.editionFingerprint } });
    assert.equal(report.status, 'verified', report.summary);
  });

  it('takes a step at exactly 1 %, and refuses one at 9 999 ppm', async () => {
    const atMinimum = await verifyUpgradeStep({
      ...jump,
      nonce: 1,
      edition: EDGES_V2,
      expected: { editionFingerprint: edgesFingerprint, stakedSlotIndex: 0, targetSlotIndex: 2, chancePpm: 10_000, chanceCompact: '1.00%', drawnPpmValue: 186_669, outcome: 'lost', stepNo: 1 },
    });
    assert.equal(atMinimum.status, 'verified', atMinimum.summary);

    const under = await verifyUpgradeStep({
      ...jump,
      nonce: 1,
      edition: EDGES_V2,
      expected: { editionFingerprint: edgesFingerprint, stakedSlotIndex: 0, targetSlotIndex: 1, chancePpm: 9_999, chanceCompact: '0.99%', drawnPpmValue: 186_669, outcome: 'lost', stepNo: 1 },
    });
    assert.equal(under.status, 'failed');
    assert.equal(under.firstFailure?.check, 'upgradeTarget');
    assert.deepEqual(under.checks.upgradeTarget, { ok: false, expected: '1', computed: 'none: slot 0 cannot step to slot 1' });
    assert.deepEqual(
      under.notRun.map((n) => [n.check, n.reason]),
      [
        ['upgradeChance', 'the edition allows no step from the staked slot to the target'],
        ['chanceCompact', 'the edition allows no step from the staked slot to the target'],
        ['upgradeOutcome', 'it needs the step chance, which could not be computed'],
      ],
    );
  });

  it('refuses a target that is not worth more than the staked slot, or not in the box', async () => {
    const down = await verifyUpgradeStep({ ...jump, expected: { ...jump.expected, stakedSlotIndex: 2, targetSlotIndex: 1 } });
    assert.deepEqual(down.checks.upgradeTarget, { ok: false, expected: '1', computed: 'none: slot 2 cannot step to slot 1' });
    const same = await verifyUpgradeStep({ ...jump, expected: { ...jump.expected, stakedSlotIndex: 2, targetSlotIndex: 2 } });
    assert.deepEqual(same.checks.upgradeTarget, { ok: false, expected: '2', computed: 'none: slot 2 cannot step to slot 2' });
    const missing = await verifyUpgradeStep({ ...jump, expected: { ...jump.expected, targetSlotIndex: 9 } });
    assert.deepEqual(missing.checks.upgradeTarget, { ok: false, expected: '9', computed: 'none: slot 0 cannot step to slot 9' });
    for (const report of [down, same, missing]) assert.equal(report.firstFailure?.check, 'upgradeTarget');
  });

  it('refuses a tie: a held value never steps to another slot of the same value', async () => {
    const tied: Edition = {
      ...EDITION_V2,
      slots: [
        { slotIndex: 0, probabilityPpm: 400_000, requiredBuyBackValueCents: 500n, requiredMarketValueCents: 500n },
        { slotIndex: 1, probabilityPpm: 300_000, requiredBuyBackValueCents: 1200n, requiredMarketValueCents: 1200n },
        { slotIndex: 2, probabilityPpm: 300_000, requiredBuyBackValueCents: 1200n, requiredMarketValueCents: 1200n },
      ],
    };
    const report = await verifyUpgradeStep({
      ...jump,
      edition: tied,
      expected: { ...jump.expected, editionFingerprint: await editionFingerprint(tied), stakedSlotIndex: 1, targetSlotIndex: 2, chancePpm: 1_000_000 - 1, chanceCompact: '99.99%' },
    });
    assert.deepEqual(report.checks.upgradeTarget, { ok: false, expected: '2', computed: 'none: slot 1 cannot step to slot 2' });
  });

  it('checks the chance of a jump against the formula, never the next value\'s chance', async () => {
    const nextValueChance = await verifyUpgradeStep({ ...jump, expected: { ...jump.expected, chancePpm: 416_666, chanceCompact: '41.66%' } });
    assert.equal(nextValueChance.firstFailure?.check, 'upgradeChance');
    assert.deepEqual(nextValueChance.checks.upgradeChance, { ok: false, expected: '416666', computed: '166666' });
  });

  it('refuses the same jump on version 1, as before: version 1 checks the next value up only', async () => {
    const report = await verifyUpgradeStep({ ...jump, edition: EDITION, expected: { ...jump.expected, editionFingerprint: fingerprint } });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'upgradeTarget');
    assert.deepEqual(report.checks.upgradeTarget, { ok: false, expected: '2', computed: '1' });
    assert.deepEqual(report.checks.engineVersion, { ok: true, expected: '1', computed: '1' });
  });

  it('fails closed on version 3: no other version\'s rule reads the step', async () => {
    const v3: Edition = { ...EDITION, engineVersion: 3 };
    const report = await verifyUpgradeStep({ ...jump, edition: v3, expected: { ...jump.expected, editionFingerprint: await editionFingerprint(v3) } });
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'engineVersion');
    assert.deepEqual(report.checks.engineVersion, { ok: false, expected: '1 or 2', computed: '3' });
    assert.equal(report.checks.upgradeTarget, undefined);
    assert.equal(report.trace.computedOffer, undefined);
    assert.deepEqual(
      report.notRun.map((n) => [n.check, n.reason]),
      [
        ['upgradeTarget', 'version 3 of the upgrade rules is not checked here'],
        ['upgradeChance', 'version 3 of the upgrade rules is not checked here'],
        ['chanceCompact', 'it needs the step chance, which could not be computed'],
        ['upgradeOutcome', 'it needs the step chance, which could not be computed'],
      ],
    );
  });

  it('checks a won jump as a win: the recorded slot, from the staked slot, at the formula\'s chance', async () => {
    const report = await verify(jumpWin);
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.computedSlotIndex, 2);
    assert.deepEqual(report.checks.drawnSlotIndex, { ok: true, expected: '2', computed: '2' });
  });

  it('says on a won jump that the target the step named is not compared, and names what was checked', async () => {
    // The win records its own slot on version 2, so a PASS proves an allowed target, not the named one.
    const report = await verify(jumpWin);
    assert.equal(report.status, 'verified', report.summary);
    // The other caveat is the snapshot's (no prize list was given).
    assert.ok(report.caveats.includes(
      'This win was made by an upgrade step from slot 0 on version 2 of the upgrade rules. This run checks that ' +
        'slot 2 is a target the edition allows from slot 0 on that version, that the chance is the formula\'s, ' +
        'and that the step\'s draw wins at it over the step\'s own table. Which target the step named is not ' +
        'compared here: it is shown on the step\'s own page (step 9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e11), and so ' +
        'are that the staked win really held slot 0, the cap on steps and the engine type, which this run does ' +
        'not check.',
    ), report.caveats.join('\n'));
  });

  it('fails a won jump whose recorded slot is no target of the staked slot', async () => {
    const missing = await verify({ ...jumpWin, expected: { ...jumpWin.expected, drawnSlotIndex: 9 } });
    assert.equal(missing.firstFailure?.check, 'drawnSlotIndex');
    assert.deepEqual(missing.checks.drawnSlotIndex, { ok: false, expected: '9', computed: 'none: slot 0 cannot step to slot 9' });
    const self = await verify({ ...jumpWin, expected: { ...jumpWin.expected, drawnSlotIndex: 0 } });
    assert.deepEqual(self.checks.drawnSlotIndex, { ok: false, expected: '0', computed: 'none: slot 0 cannot step to slot 0' });
  });

  it('fails a won jump recorded at a chance that is not the formula\'s, even one that wins', async () => {
    const report = await verify({ ...jumpWin, expected: { ...jumpWin.expected, stepChancePpm: 170_000, stepChanceCompact: '17.00%' } });
    assert.equal(report.firstFailure?.check, 'drawnSlotIndex');
    assert.match(report.checks.drawnSlotIndex?.computed ?? '', /the step from slot 0 has a chance of 166666 ppm, not 170000/);
  });

  it('reads a version 1 win by the next value up, as before, whatever slot it records', async () => {
    const report = await verify({ ...jumpWin, edition: EDITION, expected: { ...jumpWin.expected, editionFingerprint: fingerprint } });
    assert.equal(report.firstFailure?.check, 'drawnSlotIndex');
    assert.match(report.checks.drawnSlotIndex?.computed ?? '', /the step from slot 0 has a chance of 416666 ppm, not 166666/);
  });

  it('stays pending on a locked jump with the right shown chance, and fails a wrong one', async () => {
    const pending = await verify({ ...jumpWin, serverSeedHex: null });
    assert.equal(pending.status, 'pending', pending.summary);
    const shownWrong = await verify({ ...jumpWin, serverSeedHex: null, expected: { ...jumpWin.expected, stepChanceCompact: '41.66%' } });
    assert.deepEqual(shownWrong.checks.drawnSlotIndex, { ok: false, expected: 'chance shown 41.66%', computed: 'fair chance 16.66%' });
    const recordedWrong = await verify({ ...jumpWin, serverSeedHex: null, expected: { ...jumpWin.expected, stepChancePpm: 166_667 } });
    assert.deepEqual(recordedWrong.checks.drawnSlotIndex, { ok: false, expected: 'chance recorded 166667 ppm', computed: 'fair chance 166666 ppm' });
  });

  it('fails a locked jump whose recorded slot is no target, before the reveal', async () => {
    const report = await verify({ ...jumpWin, serverSeedHex: null, expected: { ...jumpWin.expected, drawnSlotIndex: 9 } });
    assert.equal(report.status, 'failed', report.summary);
    assert.deepEqual(report.checks.drawnSlotIndex, { ok: false, expected: 'chance shown 16.66%', computed: 'fair chance none, slot 0 cannot step to slot 9' });
  });

  it('fails closed on a win of version 3, revealed or locked', async () => {
    const v3: Edition = { ...EDITION, engineVersion: 3 };
    const v3Win = { ...jumpWin, edition: v3, expected: { ...jumpWin.expected, editionFingerprint: await editionFingerprint(v3) } };
    const revealed = await verify(v3Win);
    assert.equal(revealed.status, 'failed', revealed.summary);
    assert.deepEqual(revealed.checks.drawnSlotIndex, { ok: false, expected: '2', computed: 'none: version 3 of the upgrade rules is not checked here' });
    const locked = await verify({ ...v3Win, serverSeedHex: null });
    assert.equal(locked.status, 'failed', locked.summary);
    assert.deepEqual(locked.checks.drawnSlotIndex, {
      ok: false,
      expected: 'chance shown 16.66%',
      computed: 'fair chance none, version 3 of the upgrade rules is not checked here',
    });
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
