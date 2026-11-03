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
import { LOST_STEP, UPGRADE_EDITION, UPGRADED_OPEN, UPGRADED_OPEN_0_TO_1, upgradeAnswers, WON_STEP, WON_STEP_0_TO_1 } from "./test/upgradeExample"
import { EXAMPLE_PROOF } from "./example"
import { editionFingerprint, parseEdition } from "@verifier"
import {
  LOCKED,
  LOOKUP_WORDS,
  percentDown,
  STEP_LOCKED,
  STEP_LOOKUP_WORDS,
  UPGRADE_FAIL_WORDS,
  UPGRADE_STEP_OF,
  UPGRADE_VERDICT,
  UPGRADE_WIN,
  UPGRADE_WIN_STEP4,
  type UpgradeStepName,
  wrongChanceWords,
} from "./words"

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
    // Card 2 names where it reads the step's own claims: the step record's, never the box record's (S2).
    const source = document.querySelector("[data-step='2'] [data-source]")?.textContent ?? ""
    for (const field of ["step.engineType", "step.editionFingerprint", "step.chanceCompact"]) expect(source).toContain(field)
    expect(source).not.toContain("edition.engineType")
  })

  it("shows a step's chance rounded down on card 2: 416,666 ppm is 41.66%, never 41.67%", async () => {
    const { user } = openWithHash(`#step=${WON_STEP_0_TO_1.stepId}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    expect(document.querySelector("[data-upgrade-values]")?.textContent).toContain("416,666 in 1,000,000 (41.66%)")
  })

  // The address the player's overlay writes (S5 of the review of #16): (a) to (e).
  it("(a) looks up the open when the address has both #open= and step=", async () => {
    const { user, server } = openWithHash(`#open=${UPGRADED_OPEN.winId}&step=${WON_STEP.stepId}`)
    expect((screen.getByRole("radio", { name: STEP_LOOKUP_WORDS.kindOpen }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole("textbox", { name: "Look up an open by its id" }) as HTMLInputElement).value).toBe(UPGRADED_OPEN.winId)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    expect(server.calls[0]?.url).toBe(`${API_BASE}/verify/opens/${UPGRADED_OPEN.winId}`)
  })

  it("(b) opens the upgrade choice with an empty box and no lookup for an empty #step=", () => {
    const { server } = openWithHash("#step=")
    expect((screen.getByRole("radio", { name: STEP_LOOKUP_WORDS.kindStep }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole("textbox", { name: STEP_LOOKUP_WORDS.label }) as HTMLInputElement).value).toBe("")
    expect((screen.getByRole("button", { name: "Look up" }) as HTMLButtonElement).disabled).toBe(true)
    expect(server.calls).toEqual([])
  })

  it("(c) says an upgrade id is not one in the upgrade's words, fetching nothing", async () => {
    const { user, server } = openWithHash("#step=not-an-id")
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(screen.getByText(STEP_LOOKUP_WORDS.notAnId)).toBeTruthy())
    expect(screen.queryByText(LOOKUP_WORDS.notAnId)).toBeNull()
    expect(server.calls).toEqual([])
  })

  it("(d) says an unknown upgrade was not found, in the upgrade's words", async () => {
    const { user } = openWithHash("#step=00000000-0000-4000-8000-000000000000")
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(screen.getByText(STEP_LOOKUP_WORDS.notFound)).toBeTruthy())
    expect(screen.queryByText(LOOKUP_WORDS.notFound)).toBeNull()
  })

  it("(e) accepts an upper-case upgrade id and fetches it in lower case", async () => {
    const { user, server } = openWithHash(`#step=${WON_STEP.stepId.toUpperCase()}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    expect(server.calls[0]?.url).toBe(`${API_BASE}/verify/upgrade-steps/${WON_STEP.stepId}`)
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

  // Every check of a step fails on its own forged answer, with its own card and words (owner ruling, KAN-1154).
  // The answers are tampered where the page reads them: the step, its seed pair or its box.
  const SEED = EXAMPLE_PROOF.seedPair
  const forged: [UpgradeStepName, (a: { step: object; seedPair: object; edition: object }) => Promise<void> | void][] = [
    ["commitment", (a) => void (a.seedPair = { ...SEED, serverSeedCommitment: "ab".repeat(32) })],
    ["editionFingerprint", (a) => void (a.step = { ...a.step, editionFingerprint: "cd".repeat(32) })],
    ["engineType", (a) => void (a.step = { ...a.step, engineType: "single_draw_weighted_table" })],
    [
      "engineVersion",
      async (a) => {
        // A version-2 box whose fingerprint is its own true one: only the version can fail.
        const v2 = { ...UPGRADE_EDITION, engineVersion: 2 }
        const fp = await editionFingerprint(parseEdition(v2))
        a.edition = { ...v2, editionFingerprint: fp }
        a.step = { ...a.step, editionFingerprint: fp }
      },
    ],
    ["upgradeTarget", (a) => void (a.step = { ...a.step, targetSlotIndex: 3 })],
    ["upgradeChance", (a) => void (a.step = { ...a.step, chancePpm: 500000 })],
    ["chanceCompact", (a) => void (a.step = { ...a.step, chanceCompact: "41.00%" })],
    ["stepNo", (a) => void (a.step = { ...a.step, stepNo: 4 })],
    ["drawnPpmValue", (a) => void (a.step = { ...a.step, drawnPpmValue: 186670 })],
    ["upgradeOutcome", (a) => void (a.step = { ...a.step, outcome: "lost" })],
  ]

  it("has a forged case for every step check the library makes", () => {
    expect(forged.map(([name]) => name).sort()).toEqual(Object.keys(UPGRADE_STEP_OF).sort())
  })

  for (const [check, forge] of forged) {
    it(`fails a step whose ${check} is forged, on that check's card and words`, async () => {
      const a = { step: WON_STEP as object, seedPair: SEED as object, edition: UPGRADE_EDITION as object }
      await forge(a)
      const answers = upgradeAnswers()
      const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
      answers.set(`/verify/upgrade-steps/${WON_STEP.stepId}`, ok(a.step))
      answers.set(`/verify/seed-pairs/${SEED.seedPairId}`, ok(a.seedPair))
      answers.set(`/verify/editions/${UPGRADE_EDITION.editionId}`, ok(a.edition))
      window.location.hash = `#step=${WON_STEP.stepId}`
      const user = userEvent.setup()
      render(<App fetchFn={fakeServer(answers).fetchFn} />)
      await user.click(screen.getByRole("button", { name: "Look up" }))
      await waitFor(() => expect(verdictWord()).toBe("FAIL"))
      expect(verdictLine()).toBe(`Step ${UPGRADE_STEP_OF[check]} does not match: ${UPGRADE_FAIL_WORDS[check]}`)
      expect(document.querySelector(`[data-check='${check}']`)?.getAttribute("data-state")).toBe("mismatch")
      expect(document.querySelector(`[data-step='${UPGRADE_STEP_OF[check]}']`)?.getAttribute("data-failed")).toBe("yes")
    })
  }

  it("checks an upgraded win over the step's two ranges and links to its step", async () => {
    const { user } = openWithHash(`#open=${UPGRADED_OPEN.winId}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    const note = document.querySelector("[data-upgrade-win]")
    expect(note?.textContent).toContain(UPGRADE_WIN.note)
    // A PASS says what the open's check left to the upgrade's own (S4 of the review of #16).
    expect(note?.textContent).toContain(UPGRADE_WIN.passCaveat)
    // The owner's words, one idea per sentence (owner ruling, KAN-1154).
    expect(UPGRADE_WIN.passCaveat).toBe(
      "This page did not check the item given up for this upgrade, the kind of box, or how many upgrades came in a row. The upgrade's own check covers those.",
    )
    expect(screen.getByRole("link", { name: UPGRADE_WIN.link }).getAttribute("href")).toBe(`#step=${WON_STEP.stepId}`)
  })

  // Card 4 of an upgraded win is the step's: its two ranges, marked by the library's step outcome, never by
  // the target's slot index (MUST-1 of the review of #16). From slot 0 to slot 1, the index would mark "lost".
  function openZeroToOne(locked: boolean) {
    const answers = upgradeAnswers()
    if (locked) answers.set(`/verify/seed-pairs/${SEED.seedPairId}`, { status: 200, body: JSON.stringify({ ...SEED, revealedServerSeed: null }) })
    window.location.hash = `#open=${UPGRADED_OPEN_0_TO_1.winId}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(answers).fetchFn} />)
    return user
  }

  it("marks the winning range of an upgraded win from slot 0 to slot 1, at 416,666 ppm", async () => {
    const user = openZeroToOne(false)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    const card = document.querySelector("[data-step='4']")
    const marked = card?.querySelectorAll("[data-contains-v='yes']")
    expect(marked?.length).toBe(1)
    expect(marked?.[0]?.textContent).toContain("won")
    expect(marked?.[0]?.textContent).toContain("0 to 416,665")
    // The rows are the step's results, never named as box slots.
    expect(Array.from(card?.querySelectorAll("th") ?? []).map((th) => th.textContent)).toEqual(["Result", "Numbers it owns", "Contains v"])
    expect(card?.textContent).toContain(UPGRADE_WIN_STEP4.text[0])
    expect(card?.querySelector("[data-source]")?.textContent).toBe(UPGRADE_WIN_STEP4.source.replaceAll("`", ""))
  })

  it("draws no box range for an upgraded win while the secret is locked", async () => {
    const user = openZeroToOne(true)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("CANNOT CHECK YET"))
    const card = document.querySelector("[data-step='4']")
    expect(card?.querySelector("table")).toBeNull()
    expect(card?.querySelector("[data-contains-v]")).toBeNull()
    expect(document.querySelector("[data-upgrade-win]")?.textContent).not.toContain(UPGRADE_WIN.passCaveat)
  })

  // E2 (owner ruling, KAN-1154): an upgraded win shown at a wrong chance fails on the chance's own words,
  // never on the slot's, and also while the secret is still locked (the fair chance needs no seed).
  function openWrongChance(locked: boolean) {
    const answers = upgradeAnswers()
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
    answers.set(`/verify/opens/${UPGRADED_OPEN.winId}`, ok({ ...UPGRADED_OPEN, stepChanceCompact: "41.00%" }))
    if (locked) answers.set(`/verify/seed-pairs/${SEED.seedPairId}`, ok({ ...SEED, revealedServerSeed: null }))
    window.location.hash = `#open=${UPGRADED_OPEN.winId}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(answers).fetchFn} />)
    return user
  }
  const chanceWords = wrongChanceWords({ kind: "shown", shown: "41.00%", fair: "40.00%" })

  it("fails an upgraded win shown at a wrong chance, on the chance's words and not the slot's", async () => {
    const user = openWrongChance(false)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("FAIL"))
    expect(verdictLine()).toBe(`Step 4 does not match: ${chanceWords}`)
    const card = document.querySelector("[data-check='drawnSlotIndex']")
    expect(card?.getAttribute("data-state")).toBe("mismatch")
    expect(card?.textContent).toContain(chanceWords)
    expect(document.body.textContent).toContain("Chance shown to you")
    expect(document.body.textContent).not.toContain("Slot we recorded")
    expect(document.querySelector("[data-upgrade-win]")?.textContent).not.toContain(UPGRADE_WIN.passCaveat)
  })

  it("fails it the same way while the secret is still locked, and says the draw waits", async () => {
    const user = openWrongChance(true)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("FAIL"))
    expect(verdictLine()).toBe(`Step 4 does not match: ${chanceWords}`)
    expect(document.querySelector("[data-check='drawnPpmValue']")?.getAttribute("data-state")).toBe("not-run")
    expect(document.body.textContent).not.toContain("lands on a different slot")
  })

  // N-1 A extended (owner ruling, KAN-1154): the other seed-free faults of a locked upgraded win fail on their own words.
  async function lockedOpen(change: object) {
    const answers = upgradeAnswers()
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
    answers.set(`/verify/opens/${UPGRADED_OPEN.winId}`, ok({ ...UPGRADED_OPEN, ...change }))
    answers.set(`/verify/seed-pairs/${SEED.seedPairId}`, ok({ ...SEED, revealedServerSeed: null }))
    window.location.hash = `#open=${UPGRADED_OPEN.winId}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(answers).fetchFn} />)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("FAIL"))
  }

  it("fails a locked upgraded win whose staked slot is offered no step, saying why", async () => {
    await lockedOpen({ stakedSlotIndex: 3, stepChanceCompact: "99.00%" })
    expect(verdictLine()).toBe(`Step 4 does not match: ${wrongChanceWords({ kind: "none", shown: "99.00%", slot: "3", why: "offered no step" })}`)
  })

  it("fails a locked upgraded win whose staked slot is not in the box, saying why", async () => {
    await lockedOpen({ stakedSlotIndex: 9, stepChanceCompact: "99.00%" })
    expect(verdictLine()).toBe(`Step 4 does not match: ${wrongChanceWords({ kind: "none", shown: "99.00%", slot: "9", why: "not in the box" })}`)
  })

  it("fails a locked upgraded win whose recorded chance is not the fair one, under the recorded chance's labels", async () => {
    await lockedOpen({ stepChancePpm: 416666 })
    expect(verdictLine()).toBe(`Step 4 does not match: ${wrongChanceWords({ kind: "recorded", recorded: 416666, fair: 400000 })}`)
    expect(document.body.textContent).toContain("Chance we recorded")
    expect(document.body.textContent).not.toContain("Chance shown to you")
  })

  // A hand-made proof may carry numbers our server never sends; the FAIL still speaks of the chance (NIT-N1).
  it("words a fractional recorded chance of a locked upgraded win as the chance's fault", async () => {
    await lockedOpen({ stepChancePpm: 400000.5 })
    expect(verdictLine()).toBe(
      "Step 4 does not match: The chance recorded with this upgraded win, 400,000.5 in 1,000,000, is not its fair chance, 400,000 in 1,000,000.",
    )
    expect(document.body.textContent).not.toContain("Slot we recorded")
  })

  for (const slot of [-1, 1.5]) {
    it(`words a staked slot of ${slot} of a locked upgraded win as a slot the box does not have`, async () => {
      await lockedOpen({ stakedSlotIndex: slot })
      expect(verdictLine()).toBe(
        `Step 4 does not match: The chance shown with this upgraded win, 40.00%, cannot be a fair chance: the item given up names slot ${slot}, and this box has no slot ${slot}.`,
      )
    })
  }

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
