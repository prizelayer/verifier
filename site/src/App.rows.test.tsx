import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { editionFingerprint, parseEdition } from "@verifier"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { endRows, FIRST_ROWS, skippedRows } from "./words"

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
    // The end line names the rows after the kept one, and the total once: the gap's rows are part of the
    // total, not more on top of it. Every count comes from the fixture.
    const gapRows = V_SLOT - FIRST_ROWS
    const tailRows = SLOTS - 1 - V_SLOT
    const left = SLOTS - FIRST_ROWS - 1
    expect(gapRows + tailRows).toBe(left)
    const end = endRows(V_SLOT + 1, SLOTS - 1, left)
    expect(end).toBe(
      `Rows ${(V_SLOT + 1).toLocaleString("en")} to ${(SLOTS - 1).toLocaleString("en")} are not drawn here. ` +
        `With the rows skipped above, ${left.toLocaleString("en")} rows are not drawn in all. ` +
        "Your browser used all of them in the check.",
    )
    expect(screen.getAllByText(end).length).toBe(2) // the chances table and the ranges
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
    // Compared as a boolean and a tag: a failure must never print the 2,000-row page.
    expect(document.activeElement?.tagName).toBe("TABLE")
    expect(document.activeElement === drawn).toBe(true)
  })
})

describe("the words of a cut table", () => {
  it("names a one-row gap as one row", () => {
    expect(skippedRows(200, 200)).toBe("Row 200 is not drawn here.")
    expect(skippedRows(200, 372)).toBe("Rows 200 to 372 are not drawn here.")
  })

  it("says the count once when nothing was skipped above the tail", () => {
    expect(endRows(FIRST_ROWS, SLOTS - 1, SLOTS - FIRST_ROWS)).toBe(
      `Rows ${FIRST_ROWS} to ${(SLOTS - 1).toLocaleString("en")} are not drawn here ` +
        `(${(SLOTS - FIRST_ROWS).toLocaleString("en")} rows). Your browser used all of them in the check.`,
    )
  })

  it("names a one-row tail as one row", () => {
    expect(endRows(SLOTS - 1, SLOTS - 1, 1)).toBe(
      `Row ${(SLOTS - 1).toLocaleString("en")} is not drawn here. Your browser used it in the check.`,
    )
  })

  it("says one row in all as one row", () => {
    expect(endRows(SLOTS, SLOTS - 1, 1)).toBe(
      "With the rows skipped above, 1 row is not drawn in all. Your browser used it in the check.",
    )
  })

  it("says only the total when the kept row is the last one, so every row not drawn is in a gap above", () => {
    expect(endRows(SLOTS, SLOTS - 1, SLOTS - FIRST_ROWS - 1)).toBe(
      `With the rows skipped above, ${(SLOTS - FIRST_ROWS - 1).toLocaleString("en")} rows are not drawn in all. ` +
        "Your browser used all of them in the check.",
    )
  })
})
