import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { EXAMPLE_PROOF } from "./example"

// The example on the page is a copy of the published golden vector. This pins every value that the
// check reads against the fixture itself, so the copy cannot drift and still pass.
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/golden-vectors-v1.json"), "utf8"))
const edition = FIXTURE.editionFingerprint.vectors.find((v: { id: string }) => v.id === "canonical-unsorted-slots")
const snapshot = FIXTURE.snapshot.vectors.find((v: { id: string }) => v.id === "chains-onto-canonical-edition")

describe("the example proof", () => {
  it("carries the fixture's seed, commitment and first draw", () => {
    const draw = FIXTURE.draw.vectors[0]
    expect(EXAMPLE_PROOF.seedPair.revealedServerSeed).toBe(FIXTURE.draw.serverSeedHex)
    expect(EXAMPLE_PROOF.seedPair.serverSeedCommitment).toBe(FIXTURE.draw.commitmentHex)
    expect(EXAMPLE_PROOF.seedPair.clientSeed).toBe(draw.clientSeed)
    expect(EXAMPLE_PROOF.open.nonce).toBe(draw.nonce)
    expect(EXAMPLE_PROOF.open.drawnPpmValue).toBe(draw.ppm)
  })

  it("carries the fixture's edition and its fingerprint", () => {
    const bySlot = (a: { slotIndex: number }, b: { slotIndex: number }) => a.slotIndex - b.slotIndex
    const fromFixture = [...edition.edition.slotsAsGiven].sort(bySlot).map((s: Record<string, unknown>) => ({
      slotIndex: s.slotIndex,
      probabilityPpm: s.probabilityPpm,
      requiredBuyBackValueCents: s.requiredBuyBackValueCents,
      requiredMarketValueCents: s.requiredMarketValueCents,
    }))
    expect(EXAMPLE_PROOF.edition.slots).toEqual(fromFixture)
    expect(EXAMPLE_PROOF.edition.engineId).toBe(edition.edition.engineId)
    expect(EXAMPLE_PROOF.edition.engineVersion).toBe(edition.edition.engineVersion)
    expect(EXAMPLE_PROOF.edition.priceCents).toBe(edition.edition.priceCents)
    expect(EXAMPLE_PROOF.open.editionFingerprint).toBe(edition.editionFingerprint)
  })

  it("carries the fixture's snapshot body and hash", () => {
    expect(EXAMPLE_PROOF.snapshot.body).toEqual(JSON.parse(snapshot.body))
    expect(EXAMPLE_PROOF.open.snapshotHash).toBe(snapshot.snapshotHash)
  })
})
