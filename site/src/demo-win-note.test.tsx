/**
 * The win page of a dev-listed step, drawn whole: the win is checked under the demo rules of 17 and 18 November 2026 and
 * its verdict says so. The list is replaced for this file only, as the dev build's list would be; every
 * other file keeps the tests' empty list.
 * Refs: KAN-1751, KAN-1685
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import { UPGRADED_OPEN, UPGRADE_EDITION } from "./test/upgradeExample"
import { EXAMPLE_PROOF } from "./example"
import { App } from "./App"
import { DEMO_STEP_NOTE } from "./words"

// The list object is made before the mock and filled in the test, so the factory imports nothing.
const listed = vi.hoisted(() => new Set<string>())
vi.mock("./demoSteps", async (importActual) => ({ ...(await importActual<typeof import("./demoSteps")>()), DEMO_STEP_IDS: listed }))

afterEach(cleanup)

it("shows the dev-only note on a listed step's win, checked at 93 %", async () => {
  listed.add(UPGRADED_OPEN.upgradeStepId)
  const win = { ...UPGRADED_OPEN, stepChancePpm: 372000, stepChanceCompact: "37.20%" }
  const proof = JSON.stringify({ format: EXAMPLE_PROOF.format, open: win, seedPair: EXAMPLE_PROOF.seedPair, edition: UPGRADE_EDITION })
  render(<App />)
  fireEvent.change(screen.getByRole("textbox", { name: "Paste a proof" }), { target: { value: proof } })
  await userEvent.click(screen.getByRole("button", { name: "Check" }))
  await waitFor(() => expect(document.querySelector("[data-status]")?.getAttribute("data-status")).toBe("verified"))
  expect(screen.getByText(DEMO_STEP_NOTE)).toBeTruthy()
})
