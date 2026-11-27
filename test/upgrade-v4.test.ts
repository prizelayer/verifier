/**
 * Version 4 of the upgrade rules: a step that records an amount, checked on the step page and on the open
 * page (rng-fairness §4b; ADR-KAN-1154 amendment 9; KAN-1569 plan v1.1 T1 and T4).
 *
 * The boxes are the fixture's own families, read from the committed fixture so no slot is copied by hand,
 * plus one box built here (the cap's edge, SHOULD 2 of the cto's go 37016). Every number below was worked
 * out by hand in the plan (§4) or is a vector of the fixture; each one separates the correct code from a
 * planted bug, named on its test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  UPGRADE_CAVEATS_BY_VERSION,
  UPGRADE_ENGINE_TYPE,
  UPGRADE_RULES,
  UPGRADE_V3_CAVEATS,
  UPGRADE_V4_CAVEATS,
  boostChancePpm,
  boostDecision,
  boostKeyFor,
  boostMaxCents,
  boostStepLimits,
  bytesFromHex,
  derive,
  recordedAmountCents,
  editionFingerprint,
  stepChanceText,
  stepOutcome,
  upgradeStepRateBps,
  verify,
  verifyUpgradeStep,
  type BoostStep,
  type Edition,
  type UpgradeStepInput,
  type VerificationInput,
} from '../src/verifier.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../fixtures/golden-vectors-v1.json', import.meta.url), 'utf8'));
const SEED: string = FIXTURE.upgradeBoostChance.serverSeedHex;
const COMMITMENT: string = FIXTURE.upgradeBoostChance.commitmentHex;
const STEP_ID = '15691569-0000-4000-8000-000000000004';

interface FixtureSlot {
  slotIndex: number;
  probabilityPpm: number;
  buyBackValueCents: number;
}

function box(priceCents: bigint, slots: FixtureSlot[], engineVersion: number): Edition {
  return {
    engineId: '15691569-0000-4000-8000-000000000004',
    engineVersion,
    priceCents,
    slots: slots.map((slot) => ({
      slotIndex: slot.slotIndex,
      probabilityPpm: slot.probabilityPpm,
      requiredBuyBackValueCents: BigInt(slot.buyBackValueCents),
      requiredMarketValueCents: 0n,
    })),
  };
}

/** A family of the fixture as an edition, on the version given. */
function familyBox(section: string, id: string, engineVersion = 4): Edition {
  const family = FIXTURE[section].families.find((f: { id: string }) => f.id === id);
  assert.ok(family, `the fixture has the family ${section}/${id}`);
  return box(BigInt(family.priceCents), family.slots, engineVersion);
}

/** Box C, R 9 400: 40 / 200 / 1,000 EUR. */
const BOX_C = familyBox('upgradeBoostChance', 'boost-box-c-9400');
/** Box A, R 9 300: 40 / 200 / 1,000 / 2,000 / 100,000 EUR. */
const BOX_A = familyBox('upgradeBoostLimits', 'boost-limits-box-a-9300');
/** Exactly 93.00 %: 40 / 41 / 93 EUR. */
const EXACT = familyBox('upgradeBoostLimits', 'boost-limits-exact-9300');
/** Version 3's box rate-9300: 5.00 EUR to 4,654.65 EUR is exactly the minimum, to 4,654.66 EUR one ppm under. */
const MIN_EDGE = familyBox('upgradeBoostLimits', 'boost-limits-minimum-edge-9300');
/**
 * The cap's edge, built here: R 9 300, 40.00 EUR to 100.57 EUR. S = 500 000 × (4 000 + 10 057) and the price
 * 75.57 EUR give boxBps = ⌊70 285 000 / 7 557⌋ = 9 300.
 */
const CAP_EDGE = box(
  7557n,
  [
    { slotIndex: 0, probabilityPpm: 500_000, buyBackValueCents: 4000 },
    { slotIndex: 1, probabilityPpm: 500_000, buyBackValueCents: 10_057 },
  ],
  4,
);

/** The drawn value of `alice-seed` nonce 3 under the fixture's seed: 261 902 (vector `plus-10-won`). */
async function drawn(nonce = 3): Promise<number> {
  return (await derive(bytesFromHex(SEED), 'alice-seed', nonce)).value;
}

/** A step record with an honest draw at the chance given, and the amount as given (absent when undefined). */
async function stepRecord(edition: Edition, staked: number, target: number, chancePpm: number, boostCents?: unknown): Promise<UpgradeStepInput> {
  const v = await drawn();
  const expected: UpgradeStepInput['expected'] = {
    editionFingerprint: await editionFingerprint(edition),
    stakedSlotIndex: staked,
    targetSlotIndex: target,
    chancePpm,
    chanceCompact: stepChanceText(chancePpm),
    drawnPpmValue: v,
    outcome: stepOutcome(v, chancePpm),
    stepNo: 1,
  };
  if (boostCents !== undefined) (expected as Record<string, unknown>).boostCents = boostCents;
  return { serverSeedHex: SEED, commitmentHex: COMMITMENT, clientSeed: 'alice-seed', nonce: 3, edition, engineType: UPGRADE_ENGINE_TYPE, expected };
}

/** An upgraded win as the open page reads it: the step's draw, its chance, and the amount as given. */
async function winRecord(
  edition: Edition,
  staked: number,
  target: number,
  chancePpm: number,
  stepBoostCents?: unknown,
  revealed = true,
): Promise<VerificationInput> {
  const expected: VerificationInput['expected'] = {
    editionFingerprint: await editionFingerprint(edition),
    drawnPpmValue: await drawn(),
    drawnSlotIndex: target,
    upgradeStepId: STEP_ID,
    stakedSlotIndex: staked,
    stepChancePpm: chancePpm,
    stepChanceCompact: stepChanceText(chancePpm),
    stepOutcome: 'won',
  };
  if (stepBoostCents !== undefined) (expected as Record<string, unknown>).stepBoostCents = stepBoostCents;
  return {
    serverSeedHex: revealed ? SEED : null,
    commitmentHex: COMMITMENT,
    clientSeed: 'alice-seed',
    nonce: 3,
    edition,
    gameKind: 'upgrade',
    expected,
  };
}

function boostStep(rateBps: number, stakedCents: bigint, targetCents: bigint): BoostStep {
  return { engineVersion: 4, rateBps, stakedCents, targetCents };
}

describe('the chance with an amount (KAN-1569)', () => {
  it('reproduces box C of ADR-KAN-1154 §9.8: 40 to 200 EUR at 94 %, 21.28 EUR is the +10 key at 288 016', () => {
    assert.equal(upgradeStepRateBps(BOX_C, 4), 9400);
    const step = boostStep(9400, 4000n, 20_000n);
    assert.equal(boostChancePpm(step, 0n), 188_000);
    assert.equal(boostChancePpm(step, 2128n), 288_016);
    assert.equal(boostMaxCents(step), 6638n);
    assert.deepEqual(boostKeyFor(step, 10), { points: 10, boostCents: 2128n, chancePpm: 288_016 });
  });

  it('is exact past 2^53: R 9 300, s + b = 1,986,519,000, t = 1,234,110,000,000 gives 1 497 (M-F4)', () => {
    const step = boostStep(9300, 1_986_419_000n, 1_234_110_000_000n);
    assert.equal(boostChancePpm(step, 100_000n), 1497);
    // The premise: the same sum in floating point rounds up to 1 498, so this case separates the two.
    assert.equal(Math.ceil((9300 * 1e6 * 1_986_519_000) / (1e4 * 1_234_110_000_000)), 1498);
  });

  it('refuses 14.07 EUR on 40.00 to 100.57 EUR at 93 %: 500 001 ppm is over the cap, 14.06 EUR is the highest (M-C4)', () => {
    const step = boostStep(9300, 4000n, 10_057n);
    assert.equal(boostChancePpm(step, 1407n), 500_001);
    assert.equal(boostChancePpm(step, 1406n), 499_909);
    assert.deepEqual(boostDecision(step, 1407n), { decision: 'refused', refusal: 'boost_too_high', boostMaxCents: 1406n });
    assert.equal(boostMaxCents(step), 1406n);
  });

  it('names an amount that reaches the target value, and has no chance for it', () => {
    const step = boostStep(9300, 4000n, 20_000n);
    assert.throws(() => boostChancePpm(step, 16_000n), /16000 cents reach the target's value/);
    assert.deepEqual(boostStepLimits(step, 16_000n), { ok: false, limit: 'reachesTarget' });
  });

  it('has no amount on versions 1 to 3', () => {
    for (const engineVersion of [1, 2, 3]) {
      assert.throws(() => boostChancePpm({ ...boostStep(9300, 4000n, 20_000n), engineVersion }, 1n), /has no amount to add/);
    }
  });
});

describe('a version 4 step on the step page (KAN-1569 plan v1.1 T1)', () => {
  it('verifies Ana\'s step: 21.28 EUR recorded on box C, 288 016 ppm', async () => {
    const report = await verifyUpgradeStep(await stepRecord(BOX_C, 0, 1, 288_016, '2128'));
    assert.equal(report.status, 'verified', report.summary);
    assert.deepEqual(report.checks.boostAmount, { ok: true, expected: '2128 cents within the limits of version 4', computed: '2128 cents within the limits of version 4' });
    assert.match(report.summary, /with an amount of 2128 cents recorded/);
  });

  it('reads an absent amount as none: box C at 188 000 verifies, and 288 016 with no amount fails', async () => {
    const plain = await verifyUpgradeStep(await stepRecord(BOX_C, 0, 1, 188_000));
    assert.equal(plain.status, 'verified', plain.summary);
    assert.deepEqual(plain.checks.boostAmount, { ok: true, expected: 'no amount', computed: 'no amount' });
    const unpaid = await verifyUpgradeStep(await stepRecord(BOX_C, 0, 1, 288_016));
    assert.equal(unpaid.status, 'failed');
    assert.deepEqual(unpaid.checks.upgradeChance, { ok: false, expected: '288016', computed: '188000' });
  });

  it('verifies a step with no amount above the cap: 40.00 to 41.00 EUR at exactly 93 %, 907 318 ppm (M-C3)', async () => {
    const report = await verifyUpgradeStep(await stepRecord(EXACT, 0, 1, 907_318));
    assert.equal(report.status, 'verified', report.summary);
  });

  it('runs the cap\'s edge as a recorded step: 14.06 EUR verifies, 14.07 EUR at 500 001 ppm fails on the cap (SHOULD 2)', async () => {
    assert.equal(upgradeStepRateBps(CAP_EDGE, 4), 9300);
    const under = await verifyUpgradeStep(await stepRecord(CAP_EDGE, 0, 1, 499_909, '1406'));
    assert.equal(under.status, 'verified', under.summary);
    const over = await verifyUpgradeStep(await stepRecord(CAP_EDGE, 0, 1, 500_001, '1407'));
    assert.equal(over.status, 'failed');
    assert.deepEqual(over.checks.boostAmount, {
      ok: false,
      expected: '1407 cents within the limits of version 4',
      computed: '1407 cents gives a chance of 500001 ppm, above the cap of 500000 ppm',
    });
    // The chance itself is the honest one: only the amount's limit fails.
    assert.equal(over.checks.upgradeChance?.ok, true);
  });

  // The five failing steps of plan §4, one per limit; each fails on its own check with its own text.
  it('fails 1,000.01 EUR on 40 to 2,000 EUR: above the ceiling (M-S1)', async () => {
    const report = await verifyUpgradeStep(await stepRecord(BOX_A, 0, 3, 483_605, '100001'));
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.checks.boostAmount, {
      ok: false,
      expected: '100001 cents within the limits of version 4',
      computed: '100001 cents is above the ceiling of 100000 cents',
    });
    assert.equal(report.checks.upgradeChance?.ok, true);
  });

  it('fails 67.53 EUR on 40 to 200 EUR: 500 015 ppm, above the cap (M-S2)', async () => {
    const report = await verifyUpgradeStep(await stepRecord(BOX_A, 0, 1, 500_015, '6753'));
    assert.equal(report.status, 'failed');
    assert.equal(report.checks.boostAmount?.computed, '6753 cents gives a chance of 500015 ppm, above the cap of 500000 ppm');
  });

  it('fails 0.10 EUR on 1,000 to 100,000 EUR: its last cent raises nothing (M-S3)', async () => {
    const report = await verifyUpgradeStep(await stepRecord(BOX_A, 2, 4, 9301, '10'));
    assert.equal(report.status, 'failed');
    assert.equal(report.checks.boostAmount?.computed, 'the last cent of 10 cents raises nothing: 9 cents give 9301 ppm too');
  });

  it('fails 0.01 EUR on 5.00 to 4,654.66 EUR: the target is under the minimum with no amount (M-S4)', async () => {
    // p(0) = 999 and p(1) = 1 001: the minimum is read on the chance with no amount, in the target lookup.
    const report = await verifyUpgradeStep(await stepRecord(MIN_EDGE, 0, 8, 1001, '1'));
    assert.equal(report.status, 'failed');
    assert.equal(report.checks.upgradeTarget?.ok, false);
    assert.match(report.checks.upgradeTarget?.computed ?? '', /^none: /);
    assert.ok(report.notRun.some((n) => n.check === 'boostAmount'), 'the amount waits for a target');
    // The premise: one ppm more and the same amount verifies.
    const edge = await verifyUpgradeStep(await stepRecord(MIN_EDGE, 0, 7, 1001, '1'));
    assert.equal(edge.status, 'verified', edge.summary);
  });

  it('fails 160.00 EUR on 40 to 200 EUR by name: the amount reaches the target, and the record is well formed (M-S5)', async () => {
    const report = await verifyUpgradeStep(await stepRecord(BOX_A, 0, 1, 999_999, '16000'));
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.checks.boostAmount, {
      ok: false,
      expected: '16000 cents within the limits of version 4',
      computed: "the value staked plus 16000 cents reaches the target's value",
    });
    assert.ok(report.notRun.some((n) => n.check === 'upgradeChance'));
  });

  it('writes the step-number caveat of version 4', async () => {
    const report = await verifyUpgradeStep(await stepRecord(BOX_C, 0, 1, 288_016, '2128'));
    assert.ok(report.caveats.includes(UPGRADE_V4_CAVEATS.stepNo(29)));
  });
});

describe('a version 4 win on the open page (KAN-1569 plan v1.1 L9)', () => {
  it('verifies Ana\'s win with 21.28 EUR recorded, and is pending with the seed locked (M-O1)', async () => {
    const report = await verify(await winRecord(BOX_C, 0, 1, 288_016, '2128'));
    assert.equal(report.status, 'verified', report.summary);
    assert.equal(report.trace.computedSlotIndex, 1);
    const locked = await verify(await winRecord(BOX_C, 0, 1, 288_016, '2128', false));
    assert.equal(locked.status, 'pending', locked.summary);
  });

  it('fails the same win with the amount absent: 288 016 is not the 188 000 of no amount (M-O4)', async () => {
    const report = await verify(await winRecord(BOX_C, 0, 1, 288_016));
    assert.equal(report.status, 'failed');
    assert.equal(report.firstFailure?.check, 'drawnSlotIndex');
    assert.match(report.checks.drawnSlotIndex?.computed ?? '', /188000/);
  });

  // One failing input for each variant of the open page's amount sentence (SHOULD 4).
  const variants: [string, () => Promise<VerificationInput>, string][] = [
    ['above the ceiling (M-O3)', () => winRecord(BOX_A, 0, 3, 483_605, '100001'), 'amount refused, 100001 cents is above the ceiling of 100000 cents'],
    ['above the cap', () => winRecord(BOX_A, 0, 1, 500_015, '6753'), 'amount refused, 6753 cents gives a chance of 500015 ppm, above the cap of 500000 ppm'],
    ['its last cent raises nothing', () => winRecord(BOX_A, 2, 4, 9301, '10'), 'amount refused, the last cent of 10 cents raises nothing: 9 cents give 9301 ppm too'],
    ['reaches the target', () => winRecord(BOX_A, 0, 1, 999_999, '16000'), "amount refused, the value staked plus 16000 cents reaches the target's value"],
    ['on version 3 (M-O2)', () => winRecord(familyBox('upgradeBoostChance', 'boost-box-c-9400', 3), 0, 1, 288_016, '2128'), 'amount refused, version 3 of the upgrade rules has no amount'],
  ];
  for (const [name, input, computed] of variants) {
    it(`fails an amount ${name}, revealed or locked, before the draw`, async () => {
      for (const revealed of [true, false]) {
        const record = await input();
        const report = await verify(revealed ? record : { ...record, serverSeedHex: null });
        assert.equal(report.status, 'failed', `${revealed ? 'revealed' : 'locked'}: ${report.summary}`);
        assert.deepEqual(report.checks.drawnSlotIndex, { ok: false, expected: `amount recorded ${record.expected.stepBoostCents} cents`, computed });
        assert.equal(report.trace.computedSlotIndex, undefined);
        // No table and no outcome computed with an amount this run refuses (library review SHOULD 1).
        assert.equal(report.trace.cumulative, undefined);
        assert.equal(report.trace.computedStepOutcome, undefined);
      }
    });
  }

  it('writes version 4\'s win caveat, with the amount recorded (M-V2)', async () => {
    const report = await verify(await winRecord(BOX_C, 0, 1, 288_016, '2128'));
    assert.ok(report.caveats.includes(UPGRADE_V4_CAVEATS.win(0, 1, STEP_ID, 2128n)));
    assert.ok(report.caveats.some((c) => c.includes('on version 4 of the upgrade rules, with an amount of 21.28 recorded')));
    assert.ok(!report.caveats.includes(UPGRADE_V3_CAVEATS.win(0, 1, STEP_ID)));
    // With no amount, nonce 1 (186 669) wins at 188 000; the caveat then names no amount.
    const plainWin = await winRecord(BOX_C, 0, 1, 188_000);
    const plain = await verify({ ...plainWin, nonce: 1, expected: { ...plainWin.expected, drawnPpmValue: await drawn(1) } });
    assert.equal(plain.status, 'verified', plain.summary);
    assert.ok(plain.caveats.includes(UPGRADE_V4_CAVEATS.win(0, 1, STEP_ID, undefined)));
  });
});

describe('each version has its own words (KAN-1569 plan v1.1 L8)', () => {
  it('has a caveat entry for every version of the rules, and version 4\'s is its own', () => {
    for (const rule of UPGRADE_RULES) {
      assert.ok(UPGRADE_CAVEATS_BY_VERSION[rule.engineVersion], `version ${rule.engineVersion} has its own caveats`);
    }
    assert.equal(UPGRADE_CAVEATS_BY_VERSION[4], UPGRADE_V4_CAVEATS);
    assert.notEqual(UPGRADE_CAVEATS_BY_VERSION[4].win(0, 1, STEP_ID, undefined), UPGRADE_CAVEATS_BY_VERSION[3].win(0, 1, STEP_ID, undefined));
    assert.match(UPGRADE_V4_CAVEATS.win(0, 1, undefined, 100_000n), /with an amount of 1,000\.00 recorded/);
  });
});

describe('a recorded amount in a wrong shape is invalid, by name (KAN-1569 plan v1.1 T4)', () => {
  // The wire rule (cto 37069, correcting 37014): on /verify an amount is a decimal string of whole cents from 1,
  // as `priceCents` is, absent when none. Anything else is a record this library cannot read, so the status is
  // invalid, never a pass and never "not checked yet". The JSON number 2128 is the right amount in the wrong shape.
  const bad: unknown[] = [2128, 0, 21.5, '0', '-1', '+2128', '02128', '21.5', '', ' 2128', null];

  it('refuses boostCents as the JSON number 2128, 0, "0", a sign, a leading zero, a fraction or empty text on a step (M-W1, M-W2, M-W3)', async () => {
    for (const value of bad) {
      const report = await verifyUpgradeStep(await stepRecord(BOX_C, 0, 1, 288_016, value));
      assert.equal(report.status, 'invalid', `boostCents ${JSON.stringify(value)}`);
      assert.match(report.invalid?.message ?? '', /expected\.boostCents is wrongly formed/);
    }
  });

  it('refuses stepBoostCents in the same shapes on a win', async () => {
    for (const value of bad) {
      const report = await verify(await winRecord(BOX_C, 0, 1, 288_016, value));
      assert.equal(report.status, 'invalid', `stepBoostCents ${JSON.stringify(value)}`);
      assert.match(report.invalid?.message ?? '', /expected\.stepBoostCents is wrongly formed/);
    }
  });

  it('names the JSON number as a number, and reads the string "2128" as 2128 cents', () => {
    assert.throws(() => recordedAmountCents(2128, 'expected.boostCents'), /was the JSON number 2128$/);
    assert.throws(() => recordedAmountCents('02128', 'expected.boostCents'), /was the text '02128'$/);
    assert.equal(recordedAmountCents('2128', 'expected.boostCents'), 2128n);
    assert.equal(recordedAmountCents('100000', 'expected.boostCents'), 100_000n);
    assert.equal(recordedAmountCents(undefined, 'expected.boostCents'), undefined);
  });

  it('refuses stepBoostCents on an open that is not an upgrade win', async () => {
    const { gameKind: _kind, ...boxOpen } = await winRecord(BOX_C, 0, 1, 288_016, '2128');
    const report = await verify(boxOpen);
    assert.equal(report.status, 'invalid');
    assert.match(report.invalid?.message ?? '', /stepBoostCents is recorded only with an upgrade win/);
  });

  it('fails an amount on a version 3 step (M-V1)', async () => {
    const v3 = familyBox('upgradeBoostChance', 'boost-box-c-9400', 3);
    const report = await verifyUpgradeStep(await stepRecord(v3, 0, 1, 188_000, '2128'));
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.checks.boostAmount, { ok: false, expected: 'no amount: version 3 of the upgrade rules has none', computed: '2128 cents' });
  });
});

// The documentation's four version 4 examples, copied byte for byte (plan v1.1 F3). Their ids, fingerprints and
// hashes are placeholders, but their draws are the fixture seed's own (nonce 3: 261 902, nonce 1: 186 669), so
// each one verifies on box C once its placeholder fingerprint is replaced by the real one.
describe('the contract examples of version 4 (documentation specs/upgrade-step, plan v1.1 F3)', () => {
  function example(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(new URL(`../../test/fixtures/upgrade-contract/${name}.json`, import.meta.url), 'utf8'));
  }
  const STEP_WITH = example('verify-upgrade-step-won-v4');
  const STEP_NONE = example('verify-upgrade-step-v4-no-amount');
  const OPEN_WITH = example('verify-open-upgrade-win-v4');
  const OPEN_NONE = example('verify-open-upgrade-win-v4-no-amount');

  it('carries the amount as a decimal string of cents with one, and no key without one', () => {
    assert.equal(STEP_WITH.engineVersion, 4);
    assert.equal(STEP_NONE.engineVersion, 4);
    assert.equal(STEP_WITH.boostCents, '2128');
    assert.equal(OPEN_WITH.stepBoostCents, '2128');
    assert.ok(!('boostCents' in STEP_NONE), 'a step with no amount has no boostCents key');
    assert.ok(!('stepBoostCents' in OPEN_NONE), 'a win with no amount has no stepBoostCents key');
    assert.ok(!('boostCents' in OPEN_WITH), 'the open mark names the amount stepBoostCents');
    // Each open example is the win of its step example.
    assert.equal(OPEN_WITH.upgradeStepId, STEP_WITH.stepId);
    assert.equal(OPEN_WITH.winId, STEP_WITH.newWinId);
    assert.equal(OPEN_NONE.upgradeStepId, STEP_NONE.stepId);
    assert.equal(OPEN_NONE.winId, STEP_NONE.newWinId);
  });

  it('verifies both step examples on box C', async () => {
    for (const ex of [STEP_WITH, STEP_NONE]) {
      const expected: Record<string, unknown> = {
        editionFingerprint: await editionFingerprint(BOX_C),
        stakedSlotIndex: ex.stakedSlotIndex,
        targetSlotIndex: ex.targetSlotIndex,
        chancePpm: ex.chancePpm,
        chanceCompact: ex.chanceCompact,
        drawnPpmValue: ex.drawnPpmValue,
        outcome: ex.outcome,
        stepNo: ex.stepNo,
      };
      if ('boostCents' in ex) expected.boostCents = ex.boostCents;
      assert.equal(ex.drawnPpmValue, await drawn(ex.nonce as number), `${ex.stepId}: the draw is the seed's own`);
      const report = await verifyUpgradeStep({
        serverSeedHex: SEED,
        commitmentHex: COMMITMENT,
        clientSeed: 'alice-seed',
        nonce: ex.nonce as number,
        edition: BOX_C,
        engineType: ex.engineType as string,
        expected: expected as UpgradeStepInput['expected'],
      });
      assert.equal(report.status, 'verified', `${ex.stepId}: ${report.summary}`);
    }
  });

  it('verifies both open examples on box C', async () => {
    for (const ex of [OPEN_WITH, OPEN_NONE]) {
      const expected: Record<string, unknown> = {
        editionFingerprint: await editionFingerprint(BOX_C),
        drawnPpmValue: ex.drawnPpmValue,
        drawnSlotIndex: ex.drawnSlotIndex,
        upgradeStepId: ex.upgradeStepId,
        stakedSlotIndex: ex.stakedSlotIndex,
        stepChancePpm: ex.stepChancePpm,
        stepChanceCompact: ex.stepChanceCompact,
        stepOutcome: ex.stepOutcome,
      };
      if ('stepBoostCents' in ex) expected.stepBoostCents = ex.stepBoostCents;
      const report = await verify({
        serverSeedHex: SEED,
        commitmentHex: COMMITMENT,
        clientSeed: 'alice-seed',
        nonce: ex.nonce as number,
        edition: BOX_C,
        gameKind: 'upgrade',
        expected: expected as VerificationInput['expected'],
      });
      assert.equal(report.status, 'verified', `${ex.winId}: ${report.summary}`);
    }
  });
});
