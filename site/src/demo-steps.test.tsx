/**
 * The dev list in the page (KAN-1751 plan v1.2 D3 A): a listed step is checked under the demo rules of
 * 17 and 18 November 2026 and says so; an unlisted one, and every step of a build with no list, is checked under
 * its version's rule.
 * Refs: KAN-1751, KAN-1685
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { DEMO_STEP_IDS } from "./demoSteps"
import { demoStepsFor } from "../scripts/environments"
import { checkProof, joinStepProof } from "./proof"
import { UPGRADED_OPEN, UPGRADE_EDITION, WON_STEP } from "./test/upgradeExample"
import { EXAMPLE_PROOF } from "./example"
import { UpgradeStepCards } from "./upgradeSteps"
import { App } from "./App"
import { DEMO_STEP_NOTE } from "./words"

afterEach(cleanup)

// 12 → 30 EUR drawn at 93 %: 372 000 ppm, and the drawn 186 669 is under it.
const AT_93 = { ...WON_STEP, chancePpm: 372000, chanceCompact: "37.20%" }
const proofOf = (step: object) =>
  joinStepProof({ step: JSON.stringify(step), seedPair: JSON.stringify(EXAMPLE_PROOF.seedPair), edition: JSON.stringify(UPGRADE_EDITION) })
const LISTED = new Set([AT_93.stepId])

describe("the dev list of the demo steps", () => {
  it("is dev's own list in the tests (production's is pinned empty in environments.test.ts), and names no fixture", () => {
    expect([...DEMO_STEP_IDS].sort()).toEqual([...demoStepsFor("dev")].sort())
    expect(DEMO_STEP_IDS.size).toBe(68)
    for (const id of [AT_93.stepId, WON_STEP.stepId, UPGRADED_OPEN.upgradeStepId]) expect(DEMO_STEP_IDS.has(id)).toBe(false)
  })

  it("checks a listed step under the demo rules, and the page says so", async () => {
    const checked = await checkProof(proofOf(AT_93), LISTED)
    if (checked.kind !== "stepReport" || checked.input === null) throw new Error(`not a step report: ${checked.kind}`)
    expect(checked.report.status).toBe("verified")
    expect(checked.report.trace.ruleSet).toBe("DEMO_RULES_2026_11_17")
    render(<UpgradeStepCards report={checked.report} input={checked.input} />)
    expect(screen.getByText(DEMO_STEP_NOTE)).toBeTruthy()
  })

  it("checks the same step under its version's rule when it is not listed", async () => {
    for (const listed of [new Set<string>(), new Set(["9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9eff"])]) {
      const checked = await checkProof(proofOf(AT_93), listed)
      if (checked.kind !== "stepReport" || checked.input === null) throw new Error(`not a step report: ${checked.kind}`)
      expect(checked.report.status).toBe("failed")
      expect(checked.report.trace.ruleSet).toBeUndefined()
      render(<UpgradeStepCards report={checked.report} input={checked.input} />)
      expect(screen.queryByText(DEMO_STEP_NOTE)).toBeNull()
      cleanup()
    }
  })

  it("checks a fair step on the list at 93 %, so it fails", async () => {
    const checked = await checkProof(proofOf(WON_STEP), new Set([WON_STEP.stepId]))
    if (checked.kind !== "stepReport") throw new Error(`not a step report: ${checked.kind}`)
    expect(checked.report.status).toBe("failed")
    expect(checked.report.firstFailure?.check).toBe("upgradeChance")
  })
})

describe("the dev list on the page of an upgraded win", () => {
  // The win the 93 % step made: the open's own fields carry the step's chance.
  const WIN_AT_93 = { ...UPGRADED_OPEN, stepChancePpm: 372000, stepChanceCompact: "37.20%" }
  const winProof = (open: object) =>
    JSON.stringify({ format: EXAMPLE_PROOF.format, open, seedPair: EXAMPLE_PROOF.seedPair, edition: UPGRADE_EDITION })

  it("reads a listed step's win under the demo rules", async () => {
    const checked = await checkProof(winProof(WIN_AT_93), new Set([WIN_AT_93.upgradeStepId]))
    if (checked.kind !== "report") throw new Error(`not an open report: ${checked.kind}`)
    expect(checked.report.status).toBe("verified")
    expect(checked.report.trace.ruleSet).toBe("DEMO_RULES_2026_11_17")
  })

  it("reads the same win under its version's rule in a build with no list, and the page has no note", async () => {
    const checked = await checkProof(winProof(WIN_AT_93))
    if (checked.kind !== "report") throw new Error(`not an open report: ${checked.kind}`)
    expect(checked.report.status).toBe("failed")
    expect(checked.report.trace.ruleSet).toBeUndefined()
    render(<App />)
    fireEvent.change(screen.getByRole("textbox", { name: "Paste a proof" }), { target: { value: winProof(WIN_AT_93) } })
    await userEvent.click(screen.getByRole("button", { name: "Check" }))
    await waitFor(() => expect(document.querySelector("[data-status]")?.getAttribute("data-status")).toBe("failed"))
    expect(screen.queryByText(DEMO_STEP_NOTE)).toBeNull()
  })
})
