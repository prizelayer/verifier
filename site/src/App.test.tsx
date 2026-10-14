import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { parseSnapshotBody, snapshotHash } from "@verifier"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { expectNoAxeViolations } from "./test/axe"
import { CHECK_WORDS } from "./verdict"
import { FAIL_WORDS, LOCKED, NOT_TOLD_ITEM, STEPS } from "./words"

afterEach(cleanup)

/** On screen: rendered, and not inside anything hidden from sight or from a screen reader. */
const shown = (el: HTMLElement) => el.closest('[hidden], [aria-hidden="true"]') === null

type Proof = typeof EXAMPLE_PROOF & Record<string, unknown>

/** Paste `proof`, press Check, and return the verdict word (null when the page drew no verdict). */
async function check(proof: unknown): Promise<string | null> {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole("textbox", { name: "Paste a proof" }))
  await user.paste(typeof proof === "string" ? proof : JSON.stringify(proof))
  await user.click(screen.getByRole("button", { name: "Check" }))
  await screen.findByText(/^(PASS|FAIL|CANNOT CHECK|CANNOT CHECK YET)$|^This is not a (proof we can read|valid proof)/)
  return document.querySelector("[data-status] p")?.textContent ?? null
}

/**
 * The example with ONE value changed. The unchanged example is checked through the page first, so
 * a tamper row cannot pass by a page that fails everything.
 */
async function tampered(change: (proof: Proof) => void): Promise<string | null> {
  expect(await check(EXAMPLE_PROOF)).toBe("PASS")
  cleanup()
  const proof = structuredClone(EXAMPLE_PROOF) as Proof
  change(proof)
  return check(proof)
}

const stateOf = (name: string) => document.querySelector(`[data-check="${name}"]`)?.getAttribute("data-state")
const card = (step: number) => document.querySelector(`[data-step="${step}"]`) as HTMLElement
const verdictLine = () => document.querySelectorAll("[data-status] p")[1]?.textContent

/** A FAIL whose first failure is `name`, in the words of its step, with that step's card marked. */
/** A byte view's two shown values and its word: what the reader sees, to compare with the library. */
function view(name: string) {
  const el = document.querySelector(`[data-compare="${name}"]`)
  const [recorded, computed] = [...(el?.querySelectorAll("code") ?? [])].map((c) => c.textContent)
  return { recorded, computed, word: el?.querySelector("[data-word]")?.textContent, ok: el?.getAttribute("data-ok") }
}

function expectFailAt(step: number, name: keyof typeof FAIL_WORDS) {
  expect(verdictLine()).toBe(`Step ${step} does not match: ${FAIL_WORDS[name]}`)
  // The byte view of the failed check says so too: it never draws its own "matches".
  expect(view(name)).toMatchObject({ word: "does not match", ok: "no" })
  expect(card(step).querySelector("[data-header-state]")?.textContent).toBe("(does not match)")
  expect(stateOf(name)).toBe("mismatch")
  const row = document.querySelector(`[data-check="${name}"]`)?.textContent
  expect(row).toContain(`does not match. ${FAIL_WORDS[name]}`)
  expect(row).not.toContain(CHECK_WORDS[name])
  expect(card(step).getAttribute("data-failed")).toBe("yes")
}

/** A FAIL because an input of `name` cannot be used: the input is named, and no comparison is claimed. */
function expectCannotUseAt(step: number, name: keyof typeof FAIL_WORDS, field: string) {
  const opening = `Step ${step} cannot be checked. The value ${field} cannot be used: `
  expect(verdictLine()?.slice(0, opening.length)).toBe(opening)
  expect(stateOf(name)).toBe("mismatch")
  const row = document.querySelector(`[data-check="${name}"]`)?.textContent
  expect(row).toContain("cannot be checked.")
  expect(row).not.toContain(FAIL_WORDS[name])
  expect(card(step).getAttribute("data-failed")).toBe("yes")
  expect(card(step).querySelector("[data-header-state]")?.textContent).toBe("(cannot be checked)")
}

describe("the page", () => {
  it("before a check shows the four steps with their explanations, and no verdict", () => {
    render(<App />)
    for (const { step, title } of STEPS) {
      expect(screen.getByRole("heading", { name: `Step ${step} — ${title}` })).toBeTruthy()
    }
    expect(screen.getByText(/A fair pick is worth nothing/)).toBeTruthy()
    expect(document.querySelector("[data-status]")).toBeNull()
  })

  it("shows PASS for the example, with every check matching", async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Try the example" }))

    expect(await screen.findByText("PASS")).toBeTruthy()
    const states = [...document.querySelectorAll("[data-check]")].map((li) => li.getAttribute("data-state"))
    expect(states).toEqual(["match", "match", "match", "match", "match", "match", "match"])
    expect(document.querySelector("[data-caveat]")).toBeNull()
    expect(document.querySelectorAll('[data-failed="yes"], [data-dependent]').length).toBe(0)
    // The limits are on screen together with the PASS, not only on an empty page.
    expect(screen.getByRole("heading", { name: "What this does not prove" })).toSatisfy(shown)
    expect(screen.getByText(/^You were not shown the fingerprint or the client seed before you played/)).toSatisfy(shown)
    expect(screen.getByText("So this page cannot prove, on its own, that we did not choose the secret after your open.")).toSatisfy(shown)
    expect(screen.getByText(/When our server creates a fingerprint for a player, it writes a record in its audit log\. This page does not check that record\.$/)).toSatisfy(shown)
  })

  it("clears the result as soon as the pasted proof changes: no PASS for data it was not computed from", async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Try the example" }))
    expect(await screen.findByText("PASS")).toBeTruthy()

    const field = screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement
    const changed = field.value.replace('"nonce": 1,', '"nonce": 2,')
    expect(changed).not.toBe(field.value)
    await user.clear(field)
    await user.click(field)
    await user.paste(changed)

    expect(screen.queryByText("PASS")).toBeNull()
    expect(document.querySelector("[data-status], [data-check]")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Check" }))
    expect(await screen.findByText("FAIL")).toBeTruthy()
  })

  it("drops a result whose text was edited while the check ran", async () => {
    render(<App />)
    // Click and edit in the same task, so the edit lands before the check's result arrives.
    fireEvent.click(screen.getByRole("button", { name: "Try the example" }))
    // Typing is refused while a check runs; the text guard below is what drops a stale result.
    expect((screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement).readOnly).toBe(true)
    fireEvent.change(screen.getByRole("textbox", { name: "Paste a proof" }), { target: { value: "edited" } })

    await waitFor(() => expect(screen.getByRole("button", { name: "Check" }).hasAttribute("disabled")).toBe(false))
    expect(screen.queryByText("PASS")).toBeNull()
    expect(document.querySelector("[data-status], [data-check]")).toBeNull()
  })

  it("does not say a secret was revealed when a pending proof's commitment cannot be used", async () => {
    const proof = {
      ...EXAMPLE_PROOF,
      seedPair: { ...EXAMPLE_PROOF.seedPair, revealedServerSeed: null, serverSeedCommitment: "not hex" },
    }
    expect(await check(proof)).toBe("FAIL")
    const line = "Step 1 cannot be checked. The value seedPair.serverSeedCommitment cannot be used: the commitment must be 64 hex characters."
    expect(screen.getByText(line)).toBeTruthy()
    expect(document.body.textContent).not.toContain(FAIL_WORDS.commitment)
    const row = document.querySelector('[data-check="commitment"]')?.textContent
    expect(row).toContain("The secret and its fingerprint: cannot be checked.")
    expect(row).not.toContain("does not match")
    expect(card(1).querySelector("[data-header-state]")?.textContent).toBe("(cannot be checked)")
    expect(card(1).textContent).not.toContain("The secret we revealed")
  })

  it("always shows what the page does not prove", () => {
    render(<App />)
    expect(screen.getByRole("heading", { name: "What this does not prove" })).toBeTruthy()
    expect(screen.getByText(/You were not shown the fingerprint or the client seed before you played/)).toBeTruthy()
    expect(screen.getByText("So this page cannot prove, on its own, that we did not choose the secret after your open.")).toBeTruthy()
  })

  it("has no accessibility violations after a PASS and after a FAIL", async () => {
    const user = userEvent.setup()
    const { container } = render(<App />)
    await user.click(screen.getByRole("button", { name: "Try the example" }))
    await screen.findByText("PASS")
    await expectNoAxeViolations(container)
    cleanup()
    await tampered((p) => (p.open.nonce = 2))
    await expectNoAxeViolations(document.body)
  })
})

describe("the byte views of the example", () => {
  it("step 1 shows the revealed secret and both fingerprints", async () => {
    await check(EXAMPLE_PROOF)
    expect(card(1).textContent).toContain(EXAMPLE_PROOF.seedPair.revealedServerSeed)
    expect(view("commitment")).toMatchObject({ word: "matches", ok: "yes", computed: EXAMPLE_PROOF.seedPair.serverSeedCommitment })
    expect(card(1).textContent).toContain("SHA-256")
  })

  it("step 2 cuts the exact bytes into named fields: slot 0's chance is 0003d090 = 250000", async () => {
    await check(EXAMPLE_PROOF)
    const row = [...card(2).querySelectorAll("tr")].find((tr) => tr.textContent?.startsWith("slot 0: chance (ppm)"))
    expect(row?.textContent).toBe("slot 0: chance (ppm)0003d090250000")
  })

  it("step 4 cuts the prize list into named fields, with each item written as its id", async () => {
    await check(EXAMPLE_PROOF)
    const row = [...card(4).querySelectorAll("tr")].find((tr) => tr.textContent?.startsWith("slot 0: item"))
    expect(row?.textContent).toBe("slot 0: item00112233445566778899aabbccddeeff00112233-4455-6677-8899-aabbccddeeff")
  })

  it("step 3 marks a 4-byte number that was thrown away, then the one used, then the ones not needed", async () => {
    // The specification's rejection vector: at counter 7599 the first number is too large.
    expect(
      await tampered((p) => {
        p.open.nonce = 7599
        p.open.drawnPpmValue = 369120
        p.open.drawnSlotIndex = 1
        p.received.itemId = "12345678-9abc-def0-1234-56789abcdef0"
      }),
    ).toBe("PASS")
    const words = [...card(3).querySelectorAll("[data-chunk]")].map((tr) => tr.lastElementChild?.textContent?.split(":")[0])
    expect(words).toEqual(["thrown away", "used", ...Array(6).fill("not needed")])
    expect(card(3).querySelector('[data-chunk="rejected"]')?.textContent).toContain("4,294,392,069")
    const rows = [...card(4).querySelectorAll("[data-contains-v]")].map((tr) => tr.getAttribute("data-contains-v"))
    expect(rows).toEqual(["no", "yes", "no"])
  })

  it("step 3 shows the mixed message and marks the used 4-byte number", async () => {
    await check(EXAMPLE_PROOF)
    expect(card(3).textContent).toContain("alice-seed:1:0")
    const used = card(3).querySelectorAll('[data-chunk="accepted"]')
    expect(used.length).toBe(1)
    expect(used[0].textContent).toMatch(/used: .* mod 1,000,000 = 186,669$/)
    expect(card(3).querySelectorAll("[data-chunk]").length).toBe(8)
    expect(card(3).textContent).toContain("HMAC-SHA256")
  })

  it("shows the running words while the check runs, and scrolls to the failing card", async () => {
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    render(<App />)
    fireEvent.click(screen.getByRole("button", { name: "Try the example" }))
    expect(screen.getByText("Computing in your browser…")).toBeTruthy()
    await screen.findByText("PASS")
    expect(scrolled).toEqual([])
    cleanup()
    await tampered((p) => (p.open.nonce = 2))
    expect(scrolled.at(-1)).toBe(card(3))
  })

  it("step 4 marks the one range that contains v", async () => {
    await check(EXAMPLE_PROOF)
    const rows = [...card(4).querySelectorAll("[data-contains-v]")].map((tr) => tr.getAttribute("data-contains-v"))
    expect(rows).toEqual(["yes", "no", "no"])
  })

  it("a differing fingerprint has its differing characters marked", async () => {
    await tampered((p) => (p.open.editionFingerprint = `0${p.open.editionFingerprint.slice(1)}`))
    const marks = [...card(2).querySelectorAll('[data-compare="editionFingerprint"] mark')]
    expect(marks.map((m) => m.textContent)).toEqual(["2"])
  })
})

// The tamper table of the plan: one row per input a player can change. Every row starts from a PASS.
describe("tampering", () => {
  it("one hex character of the revealed seed: FAIL at step 1, step 3 shown as dependent", async () => {
    expect(await tampered((p) => (p.seedPair.revealedServerSeed = `1${p.seedPair.revealedServerSeed.slice(1)}`))).toBe("FAIL")
    expectFailAt(1, "commitment")
    expect(card(3).querySelector("[data-dependent]")?.textContent).toBe("This step depends on a step that failed, so it proves nothing.")
    expect(card(2).querySelector("[data-dependent]")).toBeNull()
  })

  it("the commitment: FAIL at step 1", async () => {
    expect(await tampered((p) => (p.seedPair.serverSeedCommitment = `0${p.seedPair.serverSeedCommitment.slice(1)}`))).toBe("FAIL")
    expectFailAt(1, "commitment")
    expect(stateOf("drawnPpmValue")).toBe("match")
  })

  it("the seed cut to 31 bytes: FAIL at step 1, naming seedPair.revealedServerSeed", async () => {
    expect(await tampered((p) => (p.seedPair.revealedServerSeed = p.seedPair.revealedServerSeed.slice(0, 62)))).toBe("FAIL")
    expectCannotUseAt(1, "commitment", "seedPair.revealedServerSeed")
  })

  it("the client seed: FAIL at step 3", async () => {
    expect(await tampered((p) => (p.seedPair.clientSeed = "alice-seee"))).toBe("FAIL")
    expectFailAt(3, "drawnPpmValue")
  })

  it("the counter: FAIL at step 3", async () => {
    expect(await tampered((p) => (p.open.nonce = 2))).toBe("FAIL")
    expectFailAt(3, "drawnPpmValue")
    // The value shown as computed is the library's, not the recorded one shown twice.
    expect(view("drawnPpmValue")).toMatchObject({ recorded: "186669", computed: "459796" })
    expect(card(4).querySelector("[data-dependent]")).toBeTruthy()
  })

  it("the recorded v: FAIL at step 3", async () => {
    expect(await tampered((p) => (p.open.drawnPpmValue = 186670))).toBe("FAIL")
    expectFailAt(3, "drawnPpmValue")
  })

  it("one chance changed, the sum now wrong: FAIL at step 2, naming the sum", async () => {
    expect(await tampered((p) => (p.edition.slots[0].probabilityPpm = 250001))).toBe("FAIL")
    expectCannotUseAt(2, "editionFingerprint", "edition")
    expect(card(2).textContent).toContain("The chances add up to 1,000,001, not 1,000,000.")
  })

  it("two chances swapped, the sum still right: FAIL at step 2", async () => {
    expect(
      await tampered((p) => {
        p.edition.slots[1].probabilityPpm = 500000
        p.edition.slots[2].probabilityPpm = 250000
      }),
    ).toBe("FAIL")
    expectFailAt(2, "editionFingerprint")
    // Step 4 reads its ranges from the chances of step 2, so it proves nothing here.
    expect(card(4).querySelector("[data-dependent]")).toBeTruthy()
  })

  it("a frozen value in cents: FAIL at step 2", async () => {
    expect(await tampered((p) => (p.edition.slots[2].requiredBuyBackValueCents = "1501"))).toBe("FAIL")
    expectFailAt(2, "editionFingerprint")
  })

  it("the recorded fingerprint: FAIL at step 2", async () => {
    expect(await tampered((p) => (p.open.editionFingerprint = `0${p.open.editionFingerprint.slice(1)}`))).toBe("FAIL")
    expectFailAt(2, "editionFingerprint")
  })

  it("the recorded slot: FAIL at step 4", async () => {
    expect(await tampered((p) => (p.open.drawnSlotIndex = 1))).toBe("FAIL")
    expectFailAt(4, "drawnSlotIndex")
    // The range is the one the library found for v, not the slot that was claimed.
    const rows = [...card(4).querySelectorAll("[data-contains-v]")].map((tr) => tr.getAttribute("data-contains-v"))
    expect(rows).toEqual(["yes", "no", "no"])
  })

  it("a displayed value in the prize list: FAIL at step 4 (the prize list)", async () => {
    expect(await tampered((p) => (p.snapshot.body.slots[1].displayed_value_cents = 1001))).toBe("FAIL")
    expectFailAt(4, "snapshotHash")
  })

  it("a prize list of another box, with its own correct hash: FAIL at step 4 (wrong box)", async () => {
    const other = structuredClone(EXAMPLE_PROOF.snapshot.body)
    other.edition_fingerprint = "ab".repeat(32)
    const otherHash = await snapshotHash(parseSnapshotBody(other))
    expect(
      await tampered((p) => {
        p.snapshot.body = other
        p.open.snapshotHash = otherHash
      }),
    ).toBe("FAIL")
    expectFailAt(4, "snapshotEditionLink")
    expect(stateOf("snapshotHash")).toBe("match")
    expect(view("snapshotEditionLink")).toMatchObject({ recorded: EXAMPLE_PROOF.open.editionFingerprint, computed: "ab".repeat(32) })
  })

  it("the received item: FAIL at step 4 (the item)", async () => {
    expect(await tampered((p) => (p.received.itemId = "12345678-9abc-def0-1234-56789abcdef0"))).toBe("FAIL")
    expectFailAt(4, "drawnItemId")
    expect(view("drawnItemId")).toMatchObject({
      recorded: "12345678-9abc-def0-1234-56789abcdef0",
      computed: "00112233-4455-6677-8899-aabbccddeeff",
    })
  })

  it("the received item written without hyphens: the same 16 bytes, so PASS, and the item view agrees", async () => {
    expect(await tampered((p) => (p.received.itemId = "00112233445566778899aabbccddeeff"))).toBe("PASS")
    expect(view("drawnItemId")).toMatchObject({ word: "matches", ok: "yes" })
    expect(card(4).querySelectorAll('[data-compare="drawnItemId"] mark').length).toBe(0)
  })

  it("no prize list: PASS, with the item-not-checked caveat next to it", async () => {
    expect(await tampered((p) => delete (p as Record<string, unknown>).snapshot)).toBe("PASS")
    expect(document.querySelector("[data-caveat]")?.textContent).toMatch(/^The item was not checked: this proof has no prize list/)
    expect(stateOf("drawnItemId")).toBe("not-run")
  })

  it("a prize list but no received item: PASS; the item 'not checked', the list and its box checked", async () => {
    expect(await tampered((p) => delete (p as Record<string, unknown>).received)).toBe("PASS")
    expect(document.querySelector("[data-caveat]")?.textContent).toBe(
      "The item was not checked: this page was not told which item you received.",
    )
    expect(stateOf("drawnItemId")).toBe("not-run")
    expect(document.querySelector('[data-check="drawnItemId"]')?.textContent).toContain(NOT_TOLD_ITEM)
    expect(stateOf("snapshotHash")).toBe("match")
    expect(stateOf("snapshotEditionLink")).toBe("match")
  })

  it("the same, with a displayed value changed: FAIL; 'not checked' does not hide a broken list", async () => {
    expect(
      await tampered((p) => {
        delete (p as Record<string, unknown>).received
        p.snapshot.body.slots[0].displayed_value_cents = 2001
      }),
    ).toBe("FAIL")
    expectFailAt(4, "snapshotHash")
  })

  it("a prize list shared by two boxes (another edition id, the same fingerprint inside): PASS", async () => {
    expect(await tampered((p) => (p.snapshot.editionId = "99999999-8888-4777-8666-555555555555"))).toBe("PASS")
  })

  it("the secret not revealed yet: CANNOT CHECK YET; step 2 matches, steps 1 and 3 not run", async () => {
    expect(await tampered((p) => ((p.seedPair as Record<string, unknown>).revealedServerSeed = null))).toBe("CANNOT CHECK YET")
    expect(verdictLine()).toBe(LOCKED)
    expect(stateOf("editionFingerprint")).toBe("match")
    for (const name of ["commitment", "drawnPpmValue", "drawnSlotIndex"]) expect(stateOf(name)).toBe("not-run")
    // No secret was revealed, and no comparison was made: step 1 says neither.
    expect(card(1).textContent).not.toContain("The secret we revealed")
    expect(card(1).textContent).not.toContain("now computes")
    expect(card(1).textContent).toContain("The secret: not revealed yet.")
    expect(document.querySelector('[data-check="commitment"]')?.textContent).toContain("not run: the secret is still locked")
  })

  // Changed by a later ruling: a check that ran and failed fails the open, whatever is still pending.
  it("the secret not revealed AND one frozen value changed: FAIL at step 2, never CANNOT CHECK YET", async () => {
    expect(
      await tampered((p) => {
        ;(p.seedPair as Record<string, unknown>).revealedServerSeed = null
        p.edition.slots[1].requiredMarketValueCents = "1001"
      }),
    ).toBe("FAIL")
    expectFailAt(2, "editionFingerprint")
    expect(stateOf("commitment")).toBe("not-run")
  })

  it("the secret not revealed AND one chance changed (the sum now wrong): FAIL at step 2, cannot be checked", async () => {
    expect(
      await tampered((p) => {
        ;(p.seedPair as Record<string, unknown>).revealedServerSeed = null
        p.edition.slots[0].probabilityPpm = 250001
      }),
    ).toBe("FAIL")
    expectCannotUseAt(2, "editionFingerprint", "edition")
  })

  // A fallback win records the drawn slot's item; the public open does not mark it. A field the
  // page does not read changes nothing: this is the example again, with one unknown field.
  it("an unknown field on the open (isFallback) is ignored: PASS", async () => {
    expect(await tampered((p) => ((p.open as Record<string, unknown>).isFallback = true))).toBe("PASS")
    expect(stateOf("drawnItemId")).toBe("match")
  })

  // A server leaves the slot you won out of the prize list and records the hash of the shorter list.
  it.each([true, false])("a prize list without the drawn slot, its hash recomputed: FAIL at step 4 (item kept: %s)", async (keepItem) => {
    const body = { ...EXAMPLE_PROOF.snapshot.body, slots: EXAMPLE_PROOF.snapshot.body.slots.filter((s) => s.slot_index !== 0) }
    const hash = await snapshotHash(parseSnapshotBody(body))
    expect(
      await tampered((p) => {
        p.snapshot.body = body
        p.open.snapshotHash = hash
        if (!keepItem) delete (p as Record<string, unknown>).received
      }),
    ).toBe("FAIL")
    expect(stateOf("snapshotHash")).toBe("match")
    expectFailAt(4, "snapshotEditionLink")
    // The library compared the two slot lists; the view shows its two values under their own names.
    expect(view("snapshotEditionLink")).toMatchObject({ recorded: "0,1,2", computed: "1,2", word: "does not match" })
    expect(card(4).querySelector('[data-compare="snapshotEditionLink"]')?.textContent).toContain("Slots in the prize list")
    expect(stateOf("drawnItemId")).toBe("mismatch")
    expect(document.querySelector('[data-check="drawnItemId"]')?.textContent).toContain("the prize list has no entry for slot 0")
  })
})

describe("a proof the page cannot read", () => {
  // Two tools that keep a different one of two same-named keys would check different proofs.
  it.each([
    ["the honest prize list first", true],
    ["the honest prize list last", false],
  ])("a key that appears twice (%s) is refused, never resolved", async (_, honestFirst) => {
    const honest = JSON.stringify(EXAMPLE_PROOF.snapshot.body)
    const changed = honest.replace('"displayed_value_cents":5000', '"displayed_value_cents":500000')
    const [first, second] = honestFirst ? [honest, changed] : [changed, honest]
    const text = JSON.stringify(EXAMPLE_PROOF).replace(`"body":${honest}`, `"body":${first},"body":${second}`)
    expect(text).toContain(changed)
    expect(await check(text)).toBeNull()
    expect(screen.getByText('This is not a valid proof: the key "body" appears twice.')).toBeTruthy()
  })

  it.each([10_000, 20_000])("a proof nested %i levels deep is refused, and the page works again", async (depth) => {
    const deep = "[".repeat(depth) + "]".repeat(depth)
    expect(await check(JSON.stringify(EXAMPLE_PROOF).replace(/}$/, `,"deep":${deep}}`))).toBeNull()
    expect(screen.getByText("This is not a valid proof: it is nested too deeply.")).toBeTruthy()
    expect(screen.queryByText("Computing in your browser…")).toBeNull()
    expect(screen.getByRole("button", { name: "Check" }).hasAttribute("disabled")).toBe(false)
    expect((screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement).readOnly).toBe(false)
  })

  it("a second top-level prize list is refused too", async () => {
    const text = JSON.stringify(EXAMPLE_PROOF).replace(/}$/, `,"snapshot":${JSON.stringify(EXAMPLE_PROOF.snapshot)}}`)
    expect(await check(text)).toBeNull()
    expect(screen.getByText('This is not a valid proof: the key "snapshot" appears twice.')).toBeTruthy()
  })

  it("text that is not JSON: the reason under the box, and no verdict", async () => {
    expect(await check("not a proof")).toBeNull()
    expect(screen.getByText(/^This is not a proof we can read\. It should start with/)).toBeTruthy()
    expect(document.querySelector("[data-check]")).toBeNull()
  })

  it('an edition of the wrong shape ("slots": {}): CANNOT CHECK, never a blank screen or a PASS', async () => {
    expect(await tampered((p) => ((p.edition as Record<string, unknown>).slots = {}))).toBe("CANNOT CHECK")
    expect(screen.getByText("edition.slots must be an array")).toBeTruthy()
  })

  it("a missing field: CANNOT CHECK, naming the field", async () => {
    expect(await tampered((p) => delete (p.seedPair as Record<string, unknown>).revealedServerSeed)).toBe("CANNOT CHECK")
    expect(screen.getByText("The proof has no seedPair.revealedServerSeed.")).toBeTruthy()
  })

  // The fuzz row: every input the library refuses reaches the one catch-all, never a blank screen.
  it.each([
    ["a number where text belongs", (p: Proof) => ((p.open as Record<string, unknown>).editionFingerprint = 7)],
    ["an array as the open", (p: Proof) => ((p as Record<string, unknown>).open = [])],
    ["a snapshot body of the wrong version", (p: Proof) => (p.snapshot.body.format_version = 4)],
    ["a slot without its values", (p: Proof) => ((p.edition.slots as unknown[])[0] = {})],
  ])("%s: CANNOT CHECK, with a reason", async (_, change) => {
    expect(await tampered(change)).toBe("CANNOT CHECK")
    expect(verdictLine()?.length).toBeGreaterThan(0)
  })
})

describe("a displayed value above 2^53", () => {
  it("reaches the library exactly, from the pasted text", async () => {
    const big = "9007199254740993"
    const proof = structuredClone(EXAMPLE_PROOF) as Proof
    const text = JSON.stringify(proof).replace('"displayed_value_cents":5000', `"displayed_value_cents":${big}`)
    const exactHash = await snapshotHash(parseSnapshotBody(JSON.stringify(JSON.parse(JSON.stringify(proof.snapshot.body))).replace("5000", big)))
    expect(await check(text.replace(proof.open.snapshotHash, exactHash))).toBe("PASS")
  })
})
