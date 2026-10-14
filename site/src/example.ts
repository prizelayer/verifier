import { PROOF_FORMAT } from "./proof"

/**
 * A complete proof built from the published golden vector (`fixtures/golden-vectors-v1.json`, the
 * `canonical-unsorted-slots` edition and the `chains-onto-canonical-edition` snapshot), so "Try the
 * example" shows a real PASS that anyone can recompute by hand. The ids of the open, the seed pair
 * and the edition are made up; nothing in the check depends on them. `example.test.ts` pins every
 * value against the fixture, so this copy cannot drift from it.
 */
export const EXAMPLE_PROOF = {
  format: PROOF_FORMAT,
  open: {
    winId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    gameKind: "box_open",
    seedPairId: "3f2b8c1e-5d4a-4f6b-9a7c-2e1d0b9f8a76",
    nonce: 1,
    drawnPpmValue: 186669,
    drawnSlotIndex: 0,
    editionId: "5b1e2d3c-4a5f-4e6d-8c7b-9a0f1e2d3c4b",
    editionFingerprint: "290fa403670d94b94b80d580c0b86ab79e7628d98421b4ff76ebf2f031a17f44",
    snapshotHash: "19159c52d22eaba0ad100d31b5b8b643ddeb24620d761ca05ddf907c92e40617",
    chosenProbabilityPpm: 250000,
  },
  seedPair: {
    seedPairId: "3f2b8c1e-5d4a-4f6b-9a7c-2e1d0b9f8a76",
    serverSeedCommitment: "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
    clientSeed: "alice-seed",
    status: "retired",
    noncesServed: 1,
    revealedServerSeed: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    retiredAt: "2026-10-12T09:14:03Z",
    retirementReason: "age_exceeded",
  },
  edition: {
    editionId: "5b1e2d3c-4a5f-4e6d-8c7b-9a0f1e2d3c4b",
    engineId: "11111111-2222-3333-4444-555555555555",
    engineVersion: 7,
    priceCents: "1000",
    editionFingerprint: "290fa403670d94b94b80d580c0b86ab79e7628d98421b4ff76ebf2f031a17f44",
    status: "live",
    slots: [
      { slotIndex: 0, probabilityPpm: 250000, requiredBuyBackValueCents: "800", requiredMarketValueCents: "2000" },
      { slotIndex: 1, probabilityPpm: 250000, requiredBuyBackValueCents: "300", requiredMarketValueCents: "1000" },
      { slotIndex: 2, probabilityPpm: 500000, requiredBuyBackValueCents: "1500", requiredMarketValueCents: "5000" },
    ],
  },
  snapshot: {
    snapshotHash: "19159c52d22eaba0ad100d31b5b8b643ddeb24620d761ca05ddf907c92e40617",
    editionId: "5b1e2d3c-4a5f-4e6d-8c7b-9a0f1e2d3c4b",
    editionFingerprint: "290fa403670d94b94b80d580c0b86ab79e7628d98421b4ff76ebf2f031a17f44",
    body: {
      edition_fingerprint: "290fa403670d94b94b80d580c0b86ab79e7628d98421b4ff76ebf2f031a17f44",
      format_version: 3,
      slots: [
        { current_item_id: "00112233-4455-6677-8899-aabbccddeeff", displayed_media: "media/giftcard.webp", displayed_value_cents: 2000, slot_index: 0 },
        { current_item_id: "12345678-9abc-def0-1234-56789abcdef0", displayed_media: "media/voucher.webp", displayed_value_cents: 1000, slot_index: 1 },
        { current_item_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", displayed_media: "media/ps5.webp", displayed_value_cents: 5000, slot_index: 2 },
      ],
    },
  },
  received: { itemId: "00112233-4455-6677-8899-aabbccddeeff" },
}

export const EXAMPLE_TEXT = JSON.stringify(EXAMPLE_PROOF, null, 2)
