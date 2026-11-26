import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { expectNoAxeViolations } from "./test/axe"
import { type Answer, fakeServer, PAIR_RECORD, pairAnswers } from "./test/fakeServer"
import { NOT_PROVEN_SEEDS, STEP3_SEED_SET, STEPS } from "./words"

// What our record says about the pair, on the page (KAN-935 PR-4). Step 3's sentence shows when the
// record says the player set the client seed, for a proof that "Look up" fetched in this visit and
// nobody edited since. Step 1 never changes: the step 1 sentence stays as it was (a decision of
// 2026-11-26), so every case below also pins step 1 byte for byte. Every other case keeps step 3's
// words too.
// Refs: KAN-935

afterEach(() => {
  cleanup()
  window.location.hash = ""
})

const status = () => document.querySelector("[data-status]")?.getAttribute("data-status") ?? null
const card = (step: number) => document.querySelector(`[data-step="${step}"]`) as HTMLElement | null
const box = () => screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement
/** A card's own paragraphs, before its list of checks: not its source line, not the note on an earlier failure. */
function words(step: number): (string | null)[] {
  const said: (string | null)[] = []
  for (const child of card(step)?.children ?? []) {
    if (child.tagName === "UL") break
    if (child.tagName === "P" && !child.hasAttribute("data-source") && !child.hasAttribute("data-dependent")) said.push(child.textContent)
  }
  return said
}
const main = () => document.querySelector("main")?.textContent ?? ""

// Step 1's words as they are on main before PR-4, copied here, so a change in words.ts shows too.
const STEP1_BEFORE_PR4 = [
  "For every player our server creates a secret number, and publishes its fingerprint. A fingerprint is a short code computed from the number. The same number always gives the same code, and nobody can find a different number that gives that code.",
  "After the secret is retired, our server publishes the secret itself.",
  "Your browser now computes the fingerprint of the secret we revealed. If the two are equal, the secret we revealed matches the fingerprint our server published for this pair.",
]
const TODAY_STEP3 = [...STEPS[2].text]
const STEP3_WITH_SET = [STEPS[2].text[0], STEPS[2].text[1], STEP3_SEED_SET, ...STEPS[2].text.slice(2)]

/** Step 1's card as the example draws it: the same seed pair as the looked-up open below. */
async function exampleStep1(): Promise<string> {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole("button", { name: "Try the example" }))
  await waitFor(() => expect(status()).toBe("verified"))
  const html = card(1)?.outerHTML ?? ""
  cleanup()
  return html
}

/** Opens the page on the example's open, presses "Look up" and waits for the check to end in `verdict`. */
async function lookUp(answers: Map<string, Answer>, verdict = "verified") {
  window.location.hash = `#open=${EXAMPLE_PROOF.open.winId}`
  const user = userEvent.setup()
  render(<App fetchFn={fakeServer(answers).fetchFn} />)
  await user.click(screen.getByRole("button", { name: "Look up" }))
  await waitFor(() => expect(status()).toBe(verdict))
  return user
}

describe("a lookup of an open whose pair carries our record", () => {
  it.each([
    ["shown and set", PAIR_RECORD, STEP3_WITH_SET],
    ["shown, set false with no hash", { shownBeforeFirstOpen: true, clientSeedSetByPlayer: false, setEventRecordHash: null }, TODAY_STEP3],
    ["shown false, set", { ...PAIR_RECORD, shownBeforeFirstOpen: false }, STEP3_WITH_SET],
    ["shown false, set false", { shownBeforeFirstOpen: false, clientSeedSetByPlayer: false, setEventRecordHash: null }, TODAY_STEP3],
    ["set with no hash (unknown)", { ...PAIR_RECORD, setEventRecordHash: null }, TODAY_STEP3],
    ["an answer from before the fields existed", {}, TODAY_STEP3],
  ])("%s: step 1 byte for byte as before, step 3 as the record says", async (_name, record, step3) => {
    const before = await exampleStep1()
    await lookUp(pairAnswers(record))
    expect(words(1)).toEqual(STEP1_BEFORE_PR4)
    expect(card(1)?.outerHTML).toBe(before)
    expect(words(3)).toEqual(step3)
    expect(document.querySelectorAll("[data-pair-record]")).toHaveLength(step3 === STEP3_WITH_SET ? 1 : 0)
  })

  it("shown and set: the sentence is marked in step 3 only, and the page still says what it cannot prove", async () => {
    await lookUp(pairAnswers(PAIR_RECORD))
    const marked = [...document.querySelectorAll("[data-pair-record]")].map((p) => p.closest("[data-step]")?.getAttribute("data-step"))
    expect(marked).toEqual(["3"])
    // The record does not change what the page cannot prove (planted bug not-proven-dropped-when-set).
    expect(main()).toContain(NOT_PROVEN_SEEDS)
    expect(main()).toContain("So this page cannot prove, on its own, that we did not choose the secret after your open.")
    await expectNoAxeViolations(document.body)
  })
})

// On purpose, the sentence does not depend on the verdict: it is about our record of the pair and the
// order of the fingerprint and the client seed, which a failed or a pending check does not change.
describe("the sentence on a verdict that is not a PASS", () => {
  it.each([
    ["pending", { status: "active", revealedServerSeed: null, retiredAt: null, retirementReason: null }],
    ["failed", { revealedServerSeed: "ff".repeat(32) }],
  ])("%s: step 3 still has the sentence, and only step 3", async (verdict, seeds) => {
    await lookUp(pairAnswers({ ...seeds, ...PAIR_RECORD }), verdict)
    const marked = [...document.querySelectorAll("[data-pair-record]")]
    expect(marked.map((p) => p.closest("[data-step]")?.getAttribute("data-step"))).toEqual(["3"])
    expect(marked[0]?.textContent).toBe(STEP3_SEED_SET)
  })
})

describe("only a proof our lookup fetched, as fetched", () => {
  it("the example keeps today's words in step 1 and step 3, word for word", async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Try the example" }))
    await waitFor(() => expect(status()).toBe("verified"))
    expect(words(1)).toEqual(STEP1_BEFORE_PR4)
    expect(words(3)).toEqual(TODAY_STEP3)
    expect(document.querySelector("[data-pair-record]")).toBeNull()
  })

  it("a pasted proof that carries the record gets no sentence (planted bug pasted-proof-gets-words)", async () => {
    // The lookup's own proof text, then the same text pasted into a fresh page.
    const user = await lookUp(pairAnswers(PAIR_RECORD))
    const fetched = box().value
    expect(JSON.parse(fetched).seedPair).toMatchObject(PAIR_RECORD)
    cleanup()
    window.location.hash = ""
    render(<App />)
    await user.click(box())
    await user.paste(fetched)
    await user.click(screen.getByRole("button", { name: "Check" }))
    await waitFor(() => expect(status()).toBe("verified"))
    expect(words(1)).toEqual(STEP1_BEFORE_PR4)
    expect(words(3)).toEqual(TODAY_STEP3)
  })

  it("a looked-up proof that is then edited loses the sentence, also when the edit is undone (planted bug edit-after-lookup-keeps-words)", async () => {
    const user = await lookUp(pairAnswers(PAIR_RECORD))
    expect(words(3)).toEqual(STEP3_WITH_SET)
    await user.type(box(), " ")
    await user.type(box(), "{Backspace}")
    await user.click(screen.getByRole("button", { name: "Check" }))
    await waitFor(() => expect(status()).toBe("verified"))
    expect(words(1)).toEqual(STEP1_BEFORE_PR4)
    expect(words(3)).toEqual(TODAY_STEP3)
  })

  it("the example pressed after a lookup has no sentence", async () => {
    const user = await lookUp(pairAnswers(PAIR_RECORD))
    await user.click(screen.getByRole("button", { name: "Try the example" }))
    // The cards before any check show today's words too, so the check must have finished first.
    await waitFor(() => expect(status()).toBe("verified"))
    expect(JSON.parse(box().value).seedPair).not.toHaveProperty("clientSeedSetByPlayer")
    expect(words(1)).toEqual(STEP1_BEFORE_PR4)
    expect(words(3)).toEqual(TODAY_STEP3)
  })
})
