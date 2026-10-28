/**
 * The upgrade pages (KAN-1154): looking up a step by `#step=`, its proof format, its verdict and cards,
 * and an upgraded win checked over the step's two ranges with a link to its step.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { lookUpStep, stepFromFragment, API_BASE } from "./lookup"
import { checkProof, joinStepProof, NOT_A_PROOF, PROOF_FORMAT, STEP_PROOF_FORMAT } from "./proof"
import { fakeServer } from "./test/fakeServer"
import { LOST_STEP, UPGRADE_EDITION, UPGRADED_OPEN, upgradeAnswers, WON_STEP } from "./test/upgradeExample"
import { EXAMPLE_PROOF } from "./example"
import { LOCKED, percentDown, STEP_LOCKED, STEP_LOOKUP_WORDS, UPGRADE_VERDICT, UPGRADE_WIN } from "./words"

afterEach(() => {
  cleanup()
  window.location.hash = ""
})

const verdictWord = () => document.querySelector("[data-status] p")?.textContent ?? null
const verdictLine = () => document.querySelectorAll("[data-status] p")[1]?.textContent ?? null

function stepProof(step: object): string {
  return joinStepProof({
    step: JSON.stringify(step),
    seedPair: JSON.stringify(EXAMPLE_PROOF.seedPair),
    edition: JSON.stringify(UPGRADE_EDITION),
  })
}

describe("the step lookup", () => {
  it("reads the upgrade id from #step= and nothing else", () => {
    expect(stepFromFragment(`#step=${WON_STEP.stepId}`)).toBe(WON_STEP.stepId)
    expect(stepFromFragment(`#open=${WON_STEP.stepId}`)).toBeNull()
  })

  it("fetches the step, then its seed pair and box, and joins them into a step proof", async () => {
    const server = fakeServer(upgradeAnswers())
    const result = await lookUpStep(WON_STEP.stepId, server.fetchFn)
    expect(result.kind).toBe("found")
    expect(server.calls.map((c) => c.url)).toEqual([
      `${API_BASE}/verify/upgrade-steps/${WON_STEP.stepId}`,
      `${API_BASE}/verify/seed-pairs/${EXAMPLE_PROOF.seedPair.seedPairId}`,
      `${API_BASE}/verify/editions/${UPGRADE_EDITION.editionId}`,
    ])
    const proof = JSON.parse(result.kind === "found" ? result.text : "{}")
    expect(proof.format).toBe(STEP_PROOF_FORMAT)
    expect(proof.step).toEqual(WON_STEP)
  })

  it("fetches nothing for an id that is not one, and says so for a step that does not exist", async () => {
    const server = fakeServer(upgradeAnswers())
    expect((await lookUpStep("not-an-id", server.fetchFn)).kind).toBe("notAnId")
    expect(server.calls).toEqual([])
    expect((await lookUpStep("00000000-0000-4000-8000-000000000000", server.fetchFn)).kind).toBe("notFound")
  })

  it("refuses an answer for another step than the one asked for", async () => {
    const answers = upgradeAnswers()
    answers.set(`/verify/upgrade-steps/${WON_STEP.stepId}`, { status: 200, body: JSON.stringify(LOST_STEP) })
    const result = await lookUpStep(WON_STEP.stepId, fakeServer(answers).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "the upgrade it sent has a different upgrade id from the one you asked for" })
  })
})

describe("the step proof", () => {
  it("is its own format: an open proof is never read as a step, nor a step as an open", async () => {
    expect(STEP_PROOF_FORMAT).toBe("prizelayer-step-proof/1")
    expect(PROOF_FORMAT).toBe("prizelayer-proof/1")
    const checked = await checkProof(stepProof(WON_STEP))
    expect(checked.kind).toBe("stepReport")
    expect((await checkProof(JSON.stringify(EXAMPLE_PROOF))).kind).toBe("report")
    expect(await checkProof('{"format":"prizelayer-step-proof/2"}')).toEqual({ kind: "notAProof", message: NOT_A_PROOF })
  })

  it("verifies a won step and a lost step, each with its own line", async () => {
    const won = await checkProof(stepProof(WON_STEP))
    const lost = await checkProof(stepProof(LOST_STEP))
    if (won.kind !== "stepReport" || lost.kind !== "stepReport") throw new Error("not a step report")
    expect(won.report.status).toBe("verified")
    expect(won.report.trace.computedOutcome).toBe("won")
    expect(lost.report.status).toBe("verified")
    expect(lost.report.trace.computedOutcome).toBe("lost")
  })

  it("reports a step proof with a missing field as CANNOT CHECK, naming the field", async () => {
    const { outcome: _gone, ...noOutcome } = WON_STEP
    const checked = await checkProof(stepProof(noOutcome))
    if (checked.kind !== "stepReport") throw new Error("not a step report")
    expect(checked.report.status).toBe("invalid")
    expect(checked.report.invalid?.message).toBe("The proof has no step.outcome.")
    expect(checked.input).toBeNull()
  })
})

describe("the step page", () => {
  function openWithHash(hash: string) {
    window.location.hash = hash
    const user = userEvent.setup()
    const server = fakeServer(upgradeAnswers())
    render(<App fetchFn={server.fetchFn} />)
    return { user, server }
  }

  it("opens on the upgrade choice from #step=, and verifies a won step", async () => {
    const { user } = openWithHash(`#step=${WON_STEP.stepId}`)
    expect((screen.getByRole("radio", { name: STEP_LOOKUP_WORDS.kindStep }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole("textbox", { name: STEP_LOOKUP_WORDS.label }) as HTMLInputElement).value).toBe(WON_STEP.stepId)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    expect(verdictLine()).toBe(UPGRADE_VERDICT.won)
    expect(document.querySelector("[data-check='upgradeChance']")?.getAttribute("data-state")).toBe("match")
    expect(document.querySelector("[data-upgrade-values]")?.textContent).toContain("400,000 in 1,000,000 (40.00%)")
  })

  it("shows a lost step as checked and lost, with the losing range marked, never as a win", async () => {
    const { user } = openWithHash(`#step=${LOST_STEP.stepId}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    expect(verdictLine()).toBe(UPGRADE_VERDICT.lost)
    expect(document.querySelector("[data-status]")?.getAttribute("data-outcome")).toBe("lost")
    const marked = document.querySelector("[data-contains-v='yes']")
    expect(marked?.textContent).toContain("lost")
    expect(marked?.textContent).toContain("400,000 to 999,999")
  })

  it("fails a forged outcome at step 4, with the step's own words", async () => {
    const answers = upgradeAnswers()
    answers.set(`/verify/upgrade-steps/${LOST_STEP.stepId}`, { status: 200, body: JSON.stringify({ ...LOST_STEP, outcome: "won" }) })
    window.location.hash = `#step=${LOST_STEP.stepId}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(answers).fetchFn} />)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("FAIL"))
    expect(verdictLine()).toMatch(/^Step 4 does not match: With the fair chance/)
    expect(document.querySelector("[data-step='4']")?.getAttribute("data-failed")).toBe("yes")
  })

  it("checks an upgraded win over the step's two ranges and links to its step", async () => {
    const { user } = openWithHash(`#open=${UPGRADED_OPEN.winId}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    const note = document.querySelector("[data-upgrade-win]")
    expect(note?.textContent).toContain(UPGRADE_WIN.note)
    expect(screen.getByRole("link", { name: UPGRADE_WIN.link }).getAttribute("href")).toBe(`#step=${WON_STEP.stepId}`)
  })

  it("follows the link to the step without a reload, and looks the step up", async () => {
    const { user } = openWithHash(`#open=${UPGRADED_OPEN.winId}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    await user.click(screen.getByRole("link", { name: UPGRADE_WIN.link }))
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: STEP_LOOKUP_WORDS.label }) as HTMLInputElement).value).toBe(WON_STEP.stepId),
    )
  })
})

describe("the words", () => {
  it("rounds a step chance down, so it is never shown above the true chance", () => {
    expect(percentDown(416_666)).toBe("41.66%")
    expect(percentDown(400_000)).toBe("40.00%")
    expect(percentDown(375_000)).toBe("37.50%")
    expect(percentDown(100_000)).toBe("10.00%")
    expect(percentDown(99_999)).toBe("9.99%")
    expect(percentDown(100)).toBe("0.01%")
    expect(percentDown(99)).toBe("< 0.01%")
  })

  it("writes every chance of the golden vectors exactly as the server's chanceCompact", () => {
    // The fixture's strings are platform DisplayRounding.renderFloor output (KAN-1154 A2), so the page and the
    // server cannot show one chance two ways.
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/golden-vectors-v1.json"), "utf8"))
    const pairs: [number, string][] = [
      ...fixture.upgradeStep.vectors.map((v: { chancePpm: number; chanceCompact: string }) => [v.chancePpm, v.chanceCompact]),
      ...fixture.upgradeOffer.vectors.flatMap((v: { queries: { chancePpm?: number; chanceCompact?: string }[] }) =>
        v.queries.filter((q) => q.chanceCompact !== undefined).map((q) => [q.chancePpm, q.chanceCompact]),
      ),
    ]
    expect(pairs.length).toBeGreaterThanOrEqual(10)
    for (const [ppm, shown] of pairs) expect(percentDown(ppm)).toBe(shown)
  })

  it("says 'this upgrade' while its secret is locked", () => {
    expect(STEP_LOCKED).not.toBe(LOCKED)
    expect(STEP_LOCKED.startsWith("The secret for this upgrade is still locked")).toBe(true)
  })
})
