import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { editionFingerprint, parseEdition } from "@verifier"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { FIRST_ROWS, moreRows, skippedRows } from "./words"

afterEach(cleanup)

// A box of 2,000 slots of 500 parts per million each. The example's v (186,669) lands on slot 373,
// past the first rows, so the row that contains v must be kept when the rest are cut.
const SLOTS = 2_000
const V_SLOT = 373

async function bigBoxProof() {
  const slots = Array.from({ length: SLOTS }, (_, slotIndex) => ({
    slotIndex,
    probabilityPpm: 500,
    requiredBuyBackValueCents: "1",
    requiredMarketValueCents: "2",
  }))
  const edition = { ...EXAMPLE_PROOF.edition, slots }
  const fingerprint = await editionFingerprint(parseEdition(edition))
  const { snapshot: _s, received: _r, ...rest } = EXAMPLE_PROOF
  return {
    ...rest,
    open: { ...rest.open, editionFingerprint: fingerprint, drawnSlotIndex: V_SLOT, chosenProbabilityPpm: 500, snapshotHash: null },
    edition: { ...edition, editionFingerprint: fingerprint },
  }
}

describe("a box with many slots", () => {
  it("draws the first rows and the row that contains v, says how many are left, and draws all on request", async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("textbox", { name: "Paste a proof" }))
    await user.paste(JSON.stringify(await bigBoxProof()))
    await user.click(screen.getByRole("button", { name: "Check" }))
    await waitFor(() => expect(document.querySelector("[data-status] p")?.textContent).toBe("PASS"))

    const ranges = screen.getByRole("table", { name: /The ranges/ })
    const contains = ranges.querySelectorAll('[data-contains-v="yes"]')
    expect(contains).toHaveLength(1)
    expect(contains[0].querySelector("td")?.textContent).toBe(String(V_SLOT))
    // The first rows, the kept row, and the line that says what is left.
    expect(ranges.querySelectorAll("tbody tr[data-contains-v]")).toHaveLength(FIRST_ROWS + 1)
    const left = SLOTS - FIRST_ROWS - 1
    expect(screen.getAllByText(moreRows(left)).length).toBe(2) // the chances table and the ranges
    // The rows the cut skips before the kept row are named where they are missing.
    const gap = ranges.querySelectorAll("[data-skipped-rows]")
    expect([...gap].map((row) => row.textContent)).toEqual([skippedRows(FIRST_ROWS, V_SLOT - 1)])
    expect(gap[0].nextElementSibling?.getAttribute("data-contains-v")).toBe("yes")
    // The byte groups of the box are cut too: one more cut line, under the bytes the fingerprint reads.
    const cuts = [...document.querySelectorAll("[data-more-rows]")].map((row) => row.closest("table")?.querySelector("caption")?.textContent)
    expect(cuts).toEqual(["The chances of this box", "The exact bytes the fingerprint is computed from", expect.stringMatching(/^The ranges/)])

    const drawAll = screen.getAllByRole("button", { name: `Draw all ${SLOTS.toLocaleString("en")} rows` })
    await user.click(drawAll[1])
    const drawn = screen.getByRole("table", { name: /The ranges/ })
    expect(drawn.querySelectorAll("tbody tr[data-contains-v]")).toHaveLength(SLOTS)
    expect(drawn.querySelectorAll("[data-skipped-rows]")).toHaveLength(0)
    // The button went away with its row: the focus is on the table it drew, not lost to the page.
    expect(document.activeElement).toBe(drawn)
  })
})
