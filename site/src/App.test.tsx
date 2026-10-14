import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { expectNoAxeViolations } from "./test/axe"

afterEach(cleanup)

async function check(proof: unknown) {
  const user = userEvent.setup()
  render(<App />)
  const field = screen.getByRole("textbox", { name: "Paste a proof" })
  await user.click(field)
  await user.paste(typeof proof === "string" ? proof : JSON.stringify(proof))
  await user.click(screen.getByRole("button", { name: "Check" }))
  return screen.findByText(/^(PASS|FAIL|CANNOT CHECK|CANNOT CHECK YET)$/)
}

describe("the page", () => {
  it("shows PASS for the example, with every check matching", async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Try the example" }))

    expect(await screen.findByText("PASS")).toBeTruthy()
    const states = [...document.querySelectorAll("[data-check]")].map((li) => li.getAttribute("data-state"))
    expect(states).toEqual(["match", "match", "match", "match", "match", "match", "match"])
  })

  it("always shows what the page does not prove", () => {
    render(<App />)
    expect(screen.getByRole("heading", { name: "What this does not prove" })).toBeTruthy()
    expect(screen.getByText(/You were not shown the fingerprint or the client seed before you played/)).toBeTruthy()
  })

  it("has no accessibility violations after a check", async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(screen.getByRole("button", { name: "Try the example" }))
    await screen.findByText("PASS")
    await expectNoAxeViolations(container)
  })
})

// One row of the tamper table now; the full table follows with the step cards. The unchanged
// example must pass first, so this row cannot pass by a page that fails everything.
describe("tampering", () => {
  it("the unchanged example passes", async () => {
    expect((await check(EXAMPLE_PROOF)).textContent).toBe("PASS")
  })

  it("a changed counter fails at step 3", async () => {
    const tampered = { ...EXAMPLE_PROOF, open: { ...EXAMPLE_PROOF.open, nonce: 2 } }
    expect((await check(tampered)).textContent).toBe("FAIL")
    expect(screen.getByText(/^Step 3 does not match/)).toBeTruthy()
    const row = document.querySelector('[data-check="drawnPpmValue"]')
    expect(row?.getAttribute("data-state")).toBe("mismatch")
    expect(row?.textContent).toMatch(/does not match$/)
  })
})

describe("a proof the page cannot read", () => {
  it("text that is not JSON is CANNOT CHECK, with the reason", async () => {
    expect((await check("not a proof")).textContent).toBe("CANNOT CHECK")
    expect(screen.getByText(/This is not a proof we can read/)).toBeTruthy()
  })

  it('an edition of the wrong shape ("slots": {}) is CANNOT CHECK, never a blank screen or a PASS', async () => {
    const broken = { ...EXAMPLE_PROOF, edition: { ...EXAMPLE_PROOF.edition, slots: {} } }
    expect((await check(broken)).textContent).toBe("CANNOT CHECK")
    expect(screen.getByText("edition.slots must be an array")).toBeTruthy()
  })
})
