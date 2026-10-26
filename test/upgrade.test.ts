/**
 * The upgrade step's maths (rng-fairness §4b), pinned by literals: the chance, the target and the
 * won/lost reading. The worked box of KAN-1154 plan v1.2: buy-back 5 / 12 / 30 / 80 €.
 * The cross-check against the platform's golden vectors comes with A2's fixture.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type Edition,
  stepOutcome,
  stepTable,
  upgradeChancePpm,
  upgradeTarget,
  UPGRADE_MAX_STEPS,
  UPGRADE_MIN_CHANCE_PPM,
} from '../src/verifier.js';

function edition(values: number[], ppm: number[]): Pick<Edition, 'slots'> {
  return {
    slots: values.map((cents, slotIndex) => ({
      slotIndex,
      probabilityPpm: ppm[slotIndex]!,
      requiredBuyBackValueCents: BigInt(cents),
      requiredMarketValueCents: BigInt(cents),
    })),
  };
}

const WORKED = edition([500, 1200, 3000, 8000], [319_199, 470_000, 110_000, 100_801]);

describe('upgrade chance', () => {
  it('is the floor of 1 000 000 × current / next', () => {
    assert.equal(upgradeChancePpm(1200n, 3000n), 400_000);
    assert.equal(upgradeChancePpm(500n, 1200n), 416_666);
    assert.equal(upgradeChancePpm(3000n, 8000n), 375_000);
    assert.equal(upgradeChancePpm(800n, 8000n), 100_000);
    assert.equal(upgradeChancePpm(799n, 8000n), 99_875);
  });

  it('refuses a step that does not go up', () => {
    assert.throws(() => upgradeChancePpm(1200n, 1200n), /0 < current < next/);
    assert.throws(() => upgradeChancePpm(0n, 1200n), /0 < current < next/);
  });

  it('pins the engine constants', () => {
    assert.equal(UPGRADE_MIN_CHANCE_PPM, 100_000);
    assert.equal(UPGRADE_MAX_STEPS, 3);
  });
});

describe('upgrade target', () => {
  it('climbs the worked box one value at a time and stops at the top', () => {
    assert.deepEqual(upgradeTarget(WORKED, 0), { targetSlotIndex: 1, chancePpm: 416_666 });
    assert.deepEqual(upgradeTarget(WORKED, 1), { targetSlotIndex: 2, chancePpm: 400_000 });
    assert.deepEqual(upgradeTarget(WORKED, 2), { targetSlotIndex: 3, chancePpm: 375_000 });
    assert.equal(upgradeTarget(WORKED, 3), null);
  });

  it('follows value order, never slot order', () => {
    const reordered = edition([3000, 500, 8000, 1200], [110_000, 319_199, 100_801, 470_000]);
    assert.deepEqual(upgradeTarget(reordered, 1), { targetSlotIndex: 3, chancePpm: 416_666 });
    assert.deepEqual(upgradeTarget(reordered, 3), { targetSlotIndex: 0, chancePpm: 400_000 });
  });

  it('breaks a tie on the next value by the lowest slot index', () => {
    const tied = edition([1200, 3000, 3000, 500], [400_000, 100_000, 100_000, 400_000]);
    assert.deepEqual(upgradeTarget(tied, 0), { targetSlotIndex: 1, chancePpm: 400_000 });
    const tiedReversed = edition([1200, 500, 3000, 3000], [400_000, 400_000, 100_000, 100_000]);
    assert.deepEqual(upgradeTarget(tiedReversed, 0), { targetSlotIndex: 2, chancePpm: 400_000 });
  });

  it('offers at exactly 10 % and not below, even when a higher value would pass', () => {
    assert.deepEqual(upgradeTarget(edition([800, 8000], [500_000, 500_000]), 0), {
      targetSlotIndex: 1,
      chancePpm: 100_000,
    });
    assert.equal(upgradeTarget(edition([799, 8000], [500_000, 500_000]), 0), null);
  });

  it('refuses a slot that is not in the edition', () => {
    assert.throws(() => upgradeTarget(WORKED, 4), /slot 4 is not in the edition/);
  });
});

describe('step outcome', () => {
  it('is won exactly below the chance', () => {
    assert.equal(stepOutcome(399_999, 400_000), 'won');
    assert.equal(stepOutcome(400_000, 400_000), 'lost');
    assert.equal(stepOutcome(0, 400_000), 'won');
    assert.equal(stepOutcome(999_999, 400_000), 'lost');
  });

  it('draws over a two-entry table that sums to 1 000 000', () => {
    assert.deepEqual(stepTable(400_000), [
      { slotIndex: 0, probabilityPpm: 400_000 },
      { slotIndex: 1, probabilityPpm: 600_000 },
    ]);
    assert.throws(() => stepTable(0), /step chance/);
    assert.throws(() => stepTable(1_000_000), /step chance/);
  });
});
