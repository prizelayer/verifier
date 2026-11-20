/**
 * Version 3 of the upgrade on the page (KAN-1751): every sentence a version 3 step shows comes from the one
 * table, with the box's own rate as its number, and no version 1 or 2 sentence reaches it (nor the reverse).
 * The four texts of the owner's decision of 2026-11-20 (KAN-1751) are pinned here word for word.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { editionFingerprint, parseEdition, UPGRADE_V3_CAVEATS } from "@verifier"
import { App } from "./App"
import { fakeServer } from "./test/fakeServer"
import { EXAMPLE_PROOF } from "./example"
import { LOST_STEP, UPGRADED_OPEN, UPGRADE_EDITION, upgradeAnswers, WON_STEP } from "./test/upgradeExample"
import {
  rateText,
  UPGRADE_CHECK_WORDS,
  UPGRADE_JUMP_WORDS,
  UPGRADE_STEPS,
  UPGRADE_V3_WORDS,
  UPGRADE_VERDICT,
  upgradeCheckWords,
  upgradeStep2,
  upgradeWinStep4,
  UPGRADE_WIN_STEP4,
  wrongChanceLabels,
  wrongChanceShown,
  wrongChanceWords,
} from "./words"

afterEach(() => {
  cleanup()
  window.location.hash = ""
})

const verdictWord = () => document.querySelector("[data-status] p")?.textContent ?? null
const verdictLine = () => document.querySelectorAll("[data-status] p")[1]?.textContent ?? null
const card2 = () => document.querySelector("[data-step='2']")?.textContent ?? ""
const checkText = (name: string) => document.querySelector(`[data-check='${name}']`)?.textContent ?? ""

/**
 * The worked box of ADR-KAN-1154 amendment 8 §8.3 on version 3: 20.00; 5, 12, 20, 45 and 200 at 444 750 /
 * 300 000 / 140 000 / 80 000 / 35 250 ppm, so 96.36875 % and a rate of 96.36 %. Its 20 → 45 step is 428 267.
 */
const EDITION_9636 = {
  ...UPGRADE_EDITION,
  editionId: "0b7c2a1e-5d1f-4f3e-9a52-2c1d7e6f0a33",
  engineVersion: 3,
  slots: [
    { slotIndex: 0, probabilityPpm: 444750, requiredBuyBackValueCents: "500", requiredMarketValueCents: "500" },
    { slotIndex: 1, probabilityPpm: 300000, requiredBuyBackValueCents: "1200", requiredMarketValueCents: "1200" },
    { slotIndex: 2, probabilityPpm: 140000, requiredBuyBackValueCents: "2000", requiredMarketValueCents: "2000" },
    { slotIndex: 3, probabilityPpm: 80000, requiredBuyBackValueCents: "4500", requiredMarketValueCents: "4500" },
    { slotIndex: 4, probabilityPpm: 35250, requiredBuyBackValueCents: "20000", requiredMarketValueCents: "20000" },
  ],
}

/** A hand-made version 3 edition at 92.99 % (10.00; 3 and 13 at 370 100 / 629 900): no rate can be read. */
const EDITION_9299 = {
  ...UPGRADE_EDITION,
  editionId: "0b7c2a1e-5d1f-4f3e-9a52-2c1d7e6f0a34",
  engineVersion: 3,
  priceCents: "1000",
  slots: [
    { slotIndex: 0, probabilityPpm: 370100, requiredBuyBackValueCents: "300", requiredMarketValueCents: "300" },
    { slotIndex: 1, probabilityPpm: 629900, requiredBuyBackValueCents: "1300", requiredMarketValueCents: "1300" },
  ],
}

async function openStep(edition: typeof EDITION_9636, step: Record<string, unknown>) {
  const fp = await editionFingerprint(parseEdition(edition))
  const answers = upgradeAnswers()
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
  const full = { ...WON_STEP, engineVersion: 3, editionId: edition.editionId, editionFingerprint: fp, ...step }
  answers.set(`/verify/upgrade-steps/${String(full.stepId)}`, ok(full))
  answers.set(`/verify/editions/${edition.editionId}`, ok({ ...edition, editionFingerprint: fp }))
  window.location.hash = `#step=${String(full.stepId)}`
  const user = userEvent.setup()
  render(<App fetchFn={fakeServer(answers).fetchFn} />)
  await user.click(screen.getByRole("button", { name: "Look up" }))
}

/** 20.00 → 45.00 on the 9 636 box, the fourth step of a chain; nonce 1 draws 186 669, so it is won. */
const STEP_9636 = {
  stepId: "9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e31",
  stakedSlotIndex: 2,
  targetSlotIndex: 3,
  chancePpm: 428267,
  chanceCompact: "42.82%",
  stepNo: 4,
}

describe("the version 3 words", () => {
  it("carry the four approved texts word for word, on a box whose rate is 96.36 %", () => {
    // Written out here, not taken from the table: a change of one character in the table fails this test.
    const text3 =
      "The chance is fixed by the two buy-back values and the box's upgrade rate. The upgrade rate is the box's return, rounded down to 0.01 %, and at most 99.90 %; on this box it is 96.36 %, and it is never under 93 %. The chance is 96.36 % times the value you give up, divided by the value you could win, rounded up to a millionth. On a box whose upgrade rate is 96.36 %, giving up 10.00 for a chance at 20.00 is a 48.18% chance. On average you get back at least 96.36 % of what you staked."
    const text4 =
      "Your browser checks that the box is an upgrade box, that its chances match their fingerprint, that the item offered is a more valuable one in the same box, and that the chance is the box's upgrade rate times the value staked, divided by the value of the item offered, rounded up to a millionth. Your browser works out the upgrade rate itself, from the box's chances and its price: it is the box's return, rounded down to 0.01 %, and at most 99.90 %. There is no upgrade below a 0.10% chance. There is no limit on upgrades in a row: a chain ends at the most valuable prize of the box."
    const text5 = "The chance is this box's upgrade rate, 96.36 %, times the value you gave up, divided by the value offered, rounded up to a millionth."
    const text5Fail = "The chance we recorded is not this box's chance for this upgrade."
    const text6 =
      "The box's upgrade rate, 96.36 %, is worked out by your browser from the box's chances and its price: the box's return, rounded down to 0.01 %, and at most 99.90 %."
    const text6UnderFloor = "this box returns less than 93 %, which is not allowed for a box with upgrades"
    const words = upgradeStep2(3, 9636)
    expect(words.text[1]).toBe(text3)
    expect(words.text[2]).toBe(text4)
    const checks = UPGRADE_V3_WORDS.checks(9636)
    expect(checks.ok.upgradeChance).toBe(`${text5} ${text6}`)
    expect(checks.fail.upgradeChance).toBe(text5Fail)
    expect(UPGRADE_V3_WORDS.underFloorCause).toBe(text6UnderFloor)
    expect(UPGRADE_V3_WORDS.libraryCaveats).toBe(UPGRADE_V3_CAVEATS)
  })

  it("write the rate with two decimals and a space", () => {
    expect(rateText(9636)).toBe("96.36 %")
    expect(rateText(9300)).toBe("93.00 %")
    expect(rateText(9990)).toBe("99.90 %")
    expect(rateText(9405)).toBe("94.05 %")
  })

  it("never say that an upgrade gives back the box's return, and never call the chance fair", () => {
    const sentences = [
      ...upgradeStep2(3, 9636).text,
      ...upgradeStep2(3, undefined).text,
      upgradeStep2(3, 9636).title,
      ...Object.values(UPGRADE_V3_WORDS.checks(9636).ok),
      ...Object.values(UPGRADE_V3_WORDS.checks(9636).fail),
      ...Object.values(UPGRADE_V3_WORDS.checks(undefined).ok),
      upgradeWinStep4(3).source,
    ]
    for (const s of sentences) {
      expect(s).not.toMatch(/fair/i)
      expect(s).not.toMatch(/gives? back (at least )?the box's return/)
      expect(s).not.toMatch(/rate is (the box's|its) own return/)
    }
  })
})

describe("a version 3 step on the page", () => {
  it("is checked at the box's rate, and card 2 and its checks say so with the number", async () => {
    await openStep(EDITION_9636, STEP_9636)
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    expect(verdictLine()).toBe(UPGRADE_VERDICT.won)
    const card = card2()
    const words = upgradeStep2(3, 9636)
    expect(card).toContain(words.title)
    for (const p of words.text) expect(card).toContain(p)
    expect(card).toContain("on this box it is 96.36 %")
    expect(card).toContain("Your browser works out the upgrade rate itself, from the box's chances and its price")
    // No version 1 or 2 sentence: not the fair title, not the 1 % or 10 % minimum, not the limit of 3.
    expect(card).not.toContain(UPGRADE_STEPS[1].title)
    expect(card).not.toContain(UPGRADE_JUMP_WORDS.step2Text[2])
    expect(card).not.toContain(UPGRADE_STEPS[1].text[1])
    expect(card).not.toMatch(/at most 3 in a row|below a 1% chance|below a 10% chance/)
    expect(checkText("engineVersion")).toContain("The box uses version 3 of the upgrade rules, a version this page checks.")
    expect(checkText("upgradeTarget")).toContain("at a chance of 0.10% or more")
    expect(checkText("upgradeChance")).toContain("this box's upgrade rate, 96.36 %, times the value you gave up")
    expect(checkText("upgradeChance")).toContain("The box's upgrade rate, 96.36 %, is worked out by your browser from the box's chances and its price")
    expect(checkText("stepNo")).toContain("This upgrade's number is at most 29")
    expect(checkText("stepNo")).not.toMatch(/at most 3(?!\d)/)
  })

  it("fails the fair chance of the same step in version 3's words", async () => {
    await openStep(EDITION_9636, { ...STEP_9636, stepId: "9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e32", chancePpm: 444444, chanceCompact: "44.44%" })
    await waitFor(() => expect(verdictWord()).toBe("FAIL"))
    expect(verdictLine()).toBe("Step 2 does not match: The chance we recorded is not this box's chance for this upgrade.")
  })

  it("cannot check a step on a box under 93 %, and states no rate it does not have", async () => {
    await openStep(EDITION_9299, {
      stepId: "9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e33",
      stakedSlotIndex: 0,
      targetSlotIndex: 1,
      chancePpm: 214593,
      chanceCompact: "21.45%",
      stepNo: 1,
    })
    await waitFor(() => expect(verdictWord()).toBe("FAIL"))
    // The plain cause in the verdict; the library's number only in the check row of card 2.
    expect(verdictLine()).toBe("Step 2 cannot be checked: this box returns less than 93 %, which is not allowed for a box with upgrades.")
    expect(checkText("upgradeChance")).toContain("the box returns 9299 bps, under the 9300 bps floor of version 3")
    const card = card2()
    for (const p of upgradeStep2(3, undefined).text) expect(card).toContain(p)
    expect(card).not.toMatch(/on this box it is \d/)
  })

  it("keeps version 1's words on a version 1 step: no version 3 sentence reaches it", async () => {
    window.location.hash = `#step=${LOST_STEP.stepId}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(upgradeAnswers()).fetchFn} />)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdictWord()).toBe("PASS"))
    const card = card2()
    expect(card).toContain(UPGRADE_STEPS[1].title)
    expect(card).not.toMatch(/upgrade rate|0\.10%|rounded up|no limit on upgrades/)
    expect(checkText("upgradeChance")).toContain(UPGRADE_CHECK_WORDS.upgradeChance)
    expect(checkText("stepNo")).toContain(UPGRADE_CHECK_WORDS.stepNo)
  })
})

describe("card 4 of an upgraded win", () => {
  // Every card is drawn whether the checks pass or not, so the edition's version alone decides the line.
  const card4Source = async (engineVersion: number) => {
    render(<App />)
    const proof = JSON.stringify({ format: EXAMPLE_PROOF.format, open: UPGRADED_OPEN, seedPair: EXAMPLE_PROOF.seedPair, edition: { ...UPGRADE_EDITION, engineVersion } })
    fireEvent.change(screen.getByRole("textbox", { name: "Paste a proof" }), { target: { value: proof } })
    fireEvent.click(screen.getByRole("button", { name: "Check" }))
    // The page shows the example's open first; wait for the upgraded win's own card 4.
    const source = () => document.querySelector("[data-step='4'] [data-source]")?.textContent ?? ""
    await waitFor(() => expect(source()).toMatch(/^Read from the open record/))
    return source()
  }

  it("names the price and the chances on version 3, and never the fair chance", async () => {
    const source = await card4Source(3)
    expect(source).toBe(UPGRADE_V3_WORDS.winStep4Source.replaceAll("`", ""))
    expect(source).not.toMatch(/fair/i)
  })

  it("keeps the published line on versions 1 and 2", async () => {
    expect(await card4Source(1)).toBe(UPGRADE_WIN_STEP4.source.replaceAll("`", ""))
    cleanup()
    expect(await card4Source(2)).toBe(UPGRADE_WIN_STEP4.source.replaceAll("`", ""))
    expect(upgradeWinStep4(2)).toBe(UPGRADE_WIN_STEP4)
  })
})

describe("the version 3 word choice", () => {
  it("gives version 3 its own check words and leaves versions 1 and 2 as they were", () => {
    expect(upgradeCheckWords(3, 9636).ok.upgradeChance).toContain("96.36 %")
    expect(upgradeCheckWords(3, 9636).fail.upgradeChance).toBe("The chance we recorded is not this box's chance for this upgrade.")
    expect(upgradeCheckWords(2).ok.upgradeTarget).toBe(UPGRADE_JUMP_WORDS.checkWords.upgradeTarget)
    expect(upgradeCheckWords(2).ok.upgradeChance).toBe(UPGRADE_CHECK_WORDS.upgradeChance)
    expect(upgradeCheckWords(1, 9636).ok.upgradeChance).toBe(UPGRADE_CHECK_WORDS.upgradeChance)
    // A version this page does not check keeps version 1's words, as before.
    expect(upgradeStep2(4, 9636)).toEqual({ title: UPGRADE_STEPS[1].title, text: UPGRADE_STEPS[1].text })
  })

  it("words an upgraded win's chance by version, and reads a rate the library could not compute", () => {
    const shown = { kind: "shown", shown: "44.44%", fair: "42.82%" } as const
    expect(wrongChanceWords(shown, 3)).toBe("The chance shown with this upgraded win, 44.44%, is not this box's chance rounded down to 0.01 %, which is 42.82%.")
    expect(wrongChanceWords(shown, 1)).toContain("is not its fair chance")
    expect(wrongChanceLabels(3)).toEqual({ recorded: "This box's chance", shown: "This box's chance, rounded down" })
    expect(wrongChanceLabels(2)).toEqual({ recorded: "Fair chance", shown: "Fair chance, rounded down" })
    const rate = wrongChanceShown({
      ok: false,
      expected: "chance shown 21.45%",
      computed: "fair chance none, the box returns 9299 bps, under the 9300 bps floor of version 3: no such box can be published",
    })
    expect(rate).toEqual({ kind: "rate", shown: "21.45%", why: "the box returns 9299 bps, under the 9300 bps floor of version 3: no such box can be published" })
    expect(wrongChanceWords(rate!, 3)).toBe(
      "The chance shown with this upgraded win, 21.45%, cannot be checked: this box returns less than 93 %, which is not allowed for a box with upgrades.",
    )
    const price = { kind: "rate", shown: "21.45%", why: "version 3 reads the box's rate from its price, which must be above 0 cents, was 0" } as const
    expect(wrongChanceWords(price, 3)).toContain("cannot be read from its chances and its price (version 3 reads the box's rate from its price")
  })
})
