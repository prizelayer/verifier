import { EXAMPLE_PROOF } from "../example"
import type { Answer } from "./fakeServer"

/**
 * The public answers of two upgrade steps and of the win the first one made (KAN-1154), on the worked
 * box of plan v1.2: buy-back 5 / 12 / 30 / 80 EUR, a 12 EUR win (slot 1) staked for the 30 EUR item
 * (slot 2) at 400 000 ppm. They reuse the example's revealed seed pair (`alice-seed`), whose nonce 1
 * draws 186 669 (below 400 000: won) and nonce 2 draws 459 796 (lost); both values are spec rows the
 * platform pins. The fingerprint was computed once by the library and is pinned here.
 */
export const UPGRADE_EDITION = {
  editionId: "0b7c2a1e-5d1f-4f3e-9a52-2c1d7e6f0a11",
  engineId: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d",
  engineType: "single_draw_weighted_table_fair_upgrade",
  engineVersion: 1,
  priceCents: "2000",
  editionFingerprint: "51af4bcb272ddab0c512fc52d0e728d13b08f00d15821ec49b22bc6412097cff",
  status: "live",
  slots: [
    { slotIndex: 0, probabilityPpm: 319199, requiredBuyBackValueCents: "500", requiredMarketValueCents: "600" },
    { slotIndex: 1, probabilityPpm: 470000, requiredBuyBackValueCents: "1200", requiredMarketValueCents: "1400" },
    { slotIndex: 2, probabilityPpm: 110000, requiredBuyBackValueCents: "3000", requiredMarketValueCents: "3500" },
    { slotIndex: 3, probabilityPpm: 100801, requiredBuyBackValueCents: "8000", requiredMarketValueCents: "9000" },
  ],
}

const SEED_PAIR = EXAMPLE_PROOF.seedPair

/** The step answer of contract §6, won. */
export const WON_STEP = {
  stepId: "9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e01",
  engineType: "single_draw_weighted_table_fair_upgrade",
  engineVersion: 1,
  seedPairId: SEED_PAIR.seedPairId,
  nonce: 1,
  editionId: UPGRADE_EDITION.editionId,
  editionFingerprint: UPGRADE_EDITION.editionFingerprint,
  snapshotHash: null,
  stakedSlotIndex: 1,
  targetSlotIndex: 2,
  chancePpm: 400000,
  chanceCompact: "40.00%",
  drawnPpmValue: 186669,
  outcome: "won",
  newWinId: "9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e02",
  stepNo: 1,
}

/** The same step shape, lost on nonce 2. */
export const LOST_STEP = {
  ...WON_STEP,
  stepId: "9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e03",
  nonce: 2,
  drawnPpmValue: 459796,
  outcome: "lost",
  newWinId: null,
}

/** The open answer of contract §7 for the win the won step made. No prize list, so the item is not checked. */
export const UPGRADED_OPEN = {
  winId: WON_STEP.newWinId,
  gameKind: "upgrade",
  seedPairId: SEED_PAIR.seedPairId,
  nonce: 1,
  drawnPpmValue: 186669,
  drawnSlotIndex: 2,
  editionId: UPGRADE_EDITION.editionId,
  editionFingerprint: UPGRADE_EDITION.editionFingerprint,
  snapshotHash: null,
  chosenProbabilityPpm: null,
  upgradeStepId: WON_STEP.stepId,
  stakedSlotIndex: 1,
  stepChancePpm: 400000,
  stepChanceCompact: "40.00%",
  stepOutcome: "won",
}

/** Every answer above, by path, as the fake server serves them. */
export function upgradeAnswers(): Map<string, Answer> {
  const ok = (body: unknown): Answer => ({ status: 200, body: JSON.stringify(body) })
  return new Map([
    [`/verify/upgrade-steps/${WON_STEP.stepId}`, ok(WON_STEP)],
    [`/verify/upgrade-steps/${LOST_STEP.stepId}`, ok(LOST_STEP)],
    [`/verify/opens/${UPGRADED_OPEN.winId}`, ok(UPGRADED_OPEN)],
    [`/verify/seed-pairs/${SEED_PAIR.seedPairId}`, ok(SEED_PAIR)],
    [`/verify/editions/${UPGRADE_EDITION.editionId}`, ok(UPGRADE_EDITION)],
  ])
}
