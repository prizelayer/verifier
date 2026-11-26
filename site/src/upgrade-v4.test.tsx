/**
 * Version 4 of the upgrade on the page (KAN-1569 plan v1.1 §3.2, §3.3, T5): a step may record an amount with
 * the value given up. Every version 4 sentence is pinned here word for word, each failure sentence is made to
 * appear by its own input, and the words of every version come from one table, one entry per version.
 *
 * The boxes are the fixture's own version 4 families (fixtures/golden-vectors-v1.json), so no slot is copied
 * by hand. The seed pair is the example's: nonce 3 draws 261 902 (vector `plus-10-won`).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { editionFingerprint, parseEdition, UPGRADE_RULES, UPGRADE_V4_CAVEATS, UPGRADE_V3_CAVEATS } from "@verifier"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { joinProof, joinStepProof, proofInput, stepProofInput } from "./proof"
import { fakeServer } from "./test/fakeServer"
import { UPGRADE_EDITION, UPGRADED_OPEN, upgradeAnswers, WON_STEP } from "./test/upgradeExample"
import {
  amountRefusal,
  amountText,
  malformedAmount,
  percentDown,
  percentExact,
  UPGRADE_CHECK_LABELS,
  UPGRADE_V3_WORDS,
  UPGRADE_V4_WORDS,
  UPGRADE_WORDS_BY_VERSION,
  upgradeCheckWords,
  upgradeStep2,
  upgradeWinStep4,
  upgradeWords,
  UPGRADE_FAIL_WORDS,
  wrongChanceWords,
} from "./words"

afterEach(() => {
  cleanup()
  window.location.hash = ""
})

const verdictWord = () => document.querySelector("[data-status] p")?.textContent ?? null
const verdictLine = () => document.querySelectorAll("[data-status] p")[1]?.textContent ?? null
const card = (step: number) => document.querySelector(`[data-step='${step}']`)?.textContent ?? ""
const checkText = (name: string) => document.querySelector(`[data-check='${name}']`)?.textContent ?? ""
const values = () => document.querySelector("[data-upgrade-values]")?.textContent ?? ""

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "../../fixtures/golden-vectors-v1.json"), "utf8"))
const SEED = EXAMPLE_PROOF.seedPair

/** A fixture family as the edition answer the page reads, on the version given. */
function familyEdition(section: string, id: string, editionId: string, engineVersion = 4) {
  const family = FIXTURE[section].families.find((f: { id: string }) => f.id === id)
  if (!family) throw new Error(`no family ${section}/${id}`)
  return {
    ...UPGRADE_EDITION,
    editionId,
    engineVersion,
    priceCents: String(family.priceCents),
    slots: family.slots.map((s: { slotIndex: number; probabilityPpm: number; buyBackValueCents: number }) => ({
      slotIndex: s.slotIndex,
      probabilityPpm: s.probabilityPpm,
      requiredBuyBackValueCents: String(s.buyBackValueCents),
      requiredMarketValueCents: String(s.buyBackValueCents),
    })),
  }
}

type EditionAnswer = ReturnType<typeof familyEdition>

/** Box C, R 9 400: 40 / 200 / 1,000 EUR. */
const BOX_C = familyEdition("upgradeBoostChance", "boost-box-c-9400", "15690000-0000-4000-8000-0000000000c4")
/** Box A, R 9 300: 40 / 200 / 1,000 / 2,000 / 100,000 EUR. */
const BOX_A = familyEdition("upgradeBoostLimits", "boost-limits-box-a-9300", "15690000-0000-4000-8000-0000000000a4")
/** 5.00 EUR to 4,654.66 EUR (slot 8) is one ppm under the 0.10 % minimum with no amount. */
const MIN_EDGE = familyEdition("upgradeBoostLimits", "boost-limits-minimum-edge-9300", "15690000-0000-4000-8000-0000000000e4")
/** A hand-made version 4 box at 92.99 % (10.00; 3 and 13 at 370 100 / 629 900): no rate can be read. */
const BOX_9299 = {
  ...UPGRADE_EDITION,
  editionId: "15690000-0000-4000-8000-000000009299",
  engineVersion: 4,
  priceCents: "1000",
  slots: [
    { slotIndex: 0, probabilityPpm: 370100, requiredBuyBackValueCents: "300", requiredMarketValueCents: "300" },
    { slotIndex: 1, probabilityPpm: 629900, requiredBuyBackValueCents: "1300", requiredMarketValueCents: "1300" },
  ],
}

const V = 261902
const STEP_ID = "15690000-0000-4000-8000-00000000057e"
const WIN_ID = "15690000-0000-4000-8000-0000000000f1"
const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })

/** A step on `edition` drawn at nonce 3, its outcome the honest one at the chance given. */
function v4Step(staked: number, target: number, chancePpm: number, extra: Record<string, unknown> = {}) {
  return {
    ...WON_STEP,
    stepId: STEP_ID,
    engineVersion: 4,
    nonce: 3,
    stakedSlotIndex: staked,
    targetSlotIndex: target,
    chancePpm,
    chanceCompact: percentDown(chancePpm),
    drawnPpmValue: V,
    outcome: V < chancePpm ? "won" : "lost",
    stepNo: 1,
    ...extra,
  }
}

async function openStep(edition: EditionAnswer, step: Record<string, unknown>, verdict: string) {
  const fp = await editionFingerprint(parseEdition(edition))
  const answers = upgradeAnswers()
  answers.set(`/verify/upgrade-steps/${STEP_ID}`, ok({ ...step, editionId: edition.editionId, editionFingerprint: fp }))
  answers.set(`/verify/editions/${edition.editionId}`, ok({ ...edition, editionFingerprint: fp }))
  window.location.hash = `#step=${STEP_ID}`
  const user = userEvent.setup()
  render(<App fetchFn={fakeServer(answers).fetchFn} />)
  await user.click(screen.getByRole("button", { name: "Look up" }))
  await waitFor(() => expect(verdictWord()).toBe(verdict))
}

/** The win a step made, as the open answer carries it: its draw, its chance, and the amount as given. */
function v4Win(staked: number, target: number, chancePpm: number, extra: Record<string, unknown> = {}) {
  return {
    ...UPGRADED_OPEN,
    winId: WIN_ID,
    upgradeStepId: STEP_ID,
    nonce: 3,
    drawnPpmValue: V,
    drawnSlotIndex: target,
    stakedSlotIndex: staked,
    stepChancePpm: chancePpm,
    stepChanceCompact: percentDown(chancePpm),
    stepOutcome: "won",
    ...extra,
  }
}

async function openWin(edition: EditionAnswer, open: Record<string, unknown>, verdict: string, revealed = true) {
  const fp = await editionFingerprint(parseEdition(edition))
  const answers = upgradeAnswers()
  answers.set(`/verify/opens/${WIN_ID}`, ok({ ...open, editionId: edition.editionId, editionFingerprint: fp }))
  answers.set(`/verify/editions/${edition.editionId}`, ok({ ...edition, editionFingerprint: fp }))
  if (!revealed) answers.set(`/verify/seed-pairs/${SEED.seedPairId}`, ok({ ...SEED, revealedServerSeed: null }))
  window.location.hash = `#open=${WIN_ID}`
  const user = userEvent.setup()
  render(<App fetchFn={fakeServer(answers).fetchFn} />)
  await user.click(screen.getByRole("button", { name: "Look up" }))
  await waitFor(() => expect(verdictWord()).toBe(verdict))
}

describe("the words of each version", () => {
  it("has one entry for every version of the upgrade rules, each naming its own version", () => {
    // Kills M-P1: version 4 worded with version 2's (or any other version's) table.
    expect(Object.keys(UPGRADE_WORDS_BY_VERSION).map(Number).sort()).toEqual(UPGRADE_RULES.map((r) => r.engineVersion).sort())
    for (const rule of UPGRADE_RULES) {
      const words = UPGRADE_WORDS_BY_VERSION[rule.engineVersion]
      expect(words, `version ${rule.engineVersion}`).toBeDefined()
      expect(upgradeWords(rule.engineVersion)).toBe(words)
      expect(words.checks(9400, undefined).ok.engineVersion).toContain(`version ${rule.engineVersion} of the upgrade rules`)
    }
    const entries = UPGRADE_RULES.map((r) => UPGRADE_WORDS_BY_VERSION[r.engineVersion])
    expect(new Set(entries).size).toBe(entries.length)
    // Only version 4 records an amount, and versions 3 and 4 read the box's rate.
    expect(UPGRADE_RULES.filter((r) => upgradeWords(r.engineVersion).recordsAmount).map((r) => r.engineVersion)).toEqual([4])
    expect(UPGRADE_RULES.filter((r) => upgradeWords(r.engineVersion).readsRate).map((r) => r.engineVersion)).toEqual([3, 4])
  })

  it("gives a version the library does not check version 1's words, as before", () => {
    expect(upgradeWords(5)).toBe(UPGRADE_WORDS_BY_VERSION[1])
    expect(upgradeWords(undefined)).toBe(UPGRADE_WORDS_BY_VERSION[1])
  })
})

describe("the version 4 sentences", () => {
  // Written out here, not taken from the table: a change of one character in the table fails a test (M-P2).
  it("check lines: sentences 1, 2, 3, 3b, 4, 5, 6 and 22", () => {
    const withAmount = upgradeCheckWords(4, 9400, 2128)
    const noAmount = upgradeCheckWords(4, 9400, undefined)
    expect(withAmount.ok.engineVersion).toBe("The box uses version 4 of the upgrade rules, a version this page checks.")
    expect(withAmount.ok.upgradeTarget).toBe("The item you chose is worth more than the item you gave up, at a chance of 0.10% or more with no amount.")
    expect(withAmount.ok.upgradeChance).toBe(
      "Your browser computed the chance from this box's upgrade rate, 94.00 %, and the amount recorded with this upgrade. It is the chance we recorded.",
    )
    // With no amount, version 3's approved line, word for word.
    expect(noAmount.ok.upgradeChance).toBe(UPGRADE_V3_WORDS.checks(9400).ok.upgradeChance)
    expect(withAmount.fail.upgradeTarget).toBe(
      "The item you chose is not one this upgrade allows: it must be worth more than the item you gave up, at a chance of 0.10% or more with no amount. An amount recorded with the upgrade does not change this.",
    )
    expect(withAmount.ok.boostAmount).toBe(
      "The amount recorded with this upgrade, 21.28, is within the limits of the upgrade rules. It is at most 1,000.00, and the chance with it is at most 50%. Its last cent raised the chance, so no smaller amount gives the same chance.",
    )
    expect(noAmount.ok.boostAmount).toBe("No amount was recorded with this upgrade.")
    expect(upgradeCheckWords(3, 9400).ok.boostAmount).toBe("This version of the upgrade rules has no amount, and none was recorded with this upgrade.")
    expect(upgradeCheckWords(1).ok.boostAmount).toBe("This version of the upgrade rules has no amount, and none was recorded with this upgrade.")
    expect(UPGRADE_FAIL_WORDS.boostAmount).toBe("This upgrade records an amount, but this version of the upgrade rules has no amount.")
    expect(UPGRADE_CHECK_LABELS.boostAmount).toBe("The amount recorded")
    expect(withAmount.labels.boostAmount).toBe("The amount recorded")
  })

  it("failure lines: sentences 7, 8, 9, 10 and 20, on the step page and (O3) on the open page", () => {
    const fail = UPGRADE_V4_WORDS.amountFail
    expect(fail({ limit: "ceiling", cents: 100001 }, "upgrade")).toBe(
      "The amount recorded with this upgrade, 1,000.01, is more than 1,000.00, the most the upgrade rules allow.",
    )
    expect(fail({ limit: "cap", cents: 6753, chancePpm: 500015 }, "upgrade")).toBe(
      "With the amount recorded with this upgrade, 67.53, the chance would be 50.0015%. That is more than 50%, the most the upgrade rules allow.",
    )
    expect(fail({ limit: "lastCent", cents: 10 }, "upgrade")).toBe(
      "The last cent of the amount recorded with this upgrade, 0.10, did not raise the chance: 0.09 gives the same chance. The upgrade rules do not allow this.",
    )
    expect(fail({ limit: "version", cents: 2128, version: "3" }, "upgrade")).toBe(
      "This upgrade records an amount, 21.28, but version 3 of the upgrade rules has no amount.",
    )
    expect(fail({ limit: "reachesTarget", cents: 16000 }, "upgrade")).toBe(
      "The value you gave up plus the amount recorded with this upgrade, 160.00, is worth as much as the item you chose, or more. The upgrade rules do not allow this, so there is no chance to compute.",
    )
    expect(fail({ limit: "ceiling", cents: 100001 }, "win")).toBe(
      "The amount recorded with this win, 1,000.01, is more than 1,000.00, the most the upgrade rules allow.",
    )
    expect(fail({ limit: "version", cents: 2128, version: "3" }, "win")).toBe("This win records an amount, 21.28, but version 3 of the upgrade rules has no amount.")
  })

  it("a wrongly formed amount: sentence 21 and O5 say the record is wrongly formed, never 'not checked yet'", () => {
    expect(UPGRADE_V4_WORDS.malformed("upgrade")).toBe(
      "The record of this upgrade is wrongly formed: the amount recorded with it is not a whole number of cents of 0.01 or more. This page cannot check a record in this shape.",
    )
    expect(UPGRADE_V4_WORDS.malformed("win")).toBe(
      "The record of this win is wrongly formed: the amount recorded with it is not a whole number of cents of 0.01 or more. This page cannot check a record in this shape.",
    )
    for (const subject of ["upgrade", "win"] as const) {
      expect(UPGRADE_V4_WORDS.malformed(subject)).not.toMatch(/not (been )?checked yet|still locked|later/i)
    }
  })

  it("card 2: sentences 11, 11b, 12, 12b, 13 and 23", () => {
    const withAmount = upgradeStep2(4, 9400, 2128)
    const noAmount = upgradeStep2(4, 9400, undefined)
    expect(withAmount.title).toBe("The chance of your upgrade comes from this box's upgrade rate and the amount recorded with it.")
    expect(noAmount.title).toBe("The chance of your upgrade comes from this box's upgrade rate.")
    const rule =
      "The upgrade rules allow an amount from 0.01 to 1,000.00 EUR to be recorded with an upgrade. With an amount, the chance is the upgrade rate times the value you give up plus the amount, divided by the value you could win, rounded up to a millionth. The chance with an amount is at most 50%. The last cent of the amount must raise the chance. On a box whose upgrade rate is 94.00 %, giving up 40.00 with an amount of 21.28 for a chance at 200.00 is a 28.80% chance."
    const checksParagraph =
      "Your browser checks that the box is an upgrade box, that its chances match their fingerprint, and that the item offered is a more valuable one in the same box. It checks that the chance is the box's upgrade rate times the value staked plus the amount recorded, divided by the value of the item offered, rounded up to a millionth. It checks that the amount is within the limits of the upgrade rules. Your browser works out the upgrade rate itself, from the box's chances and its price: it is the box's return, rounded down to 0.01 %, and at most 99.90 %. There is no upgrade below a 0.10% chance with no amount. There is no limit on upgrades in a row: a chain ends at the most valuable prize of the box."
    const casinoLimits =
      "A casino may set lower limits on the amount than the upgrade rules do. Those limits are not in the upgrade's record, so this page checks only the limits of the upgrade rules."
    const v3 = upgradeStep2(3, 9400)
    // Version 3's first two paragraphs, kept word for word; then the rule, version 4's checks and the casino's limits.
    for (const words of [withAmount, noAmount]) expect(words.text).toEqual([v3.text[0], v3.text[1], rule, checksParagraph, casinoLimits])
    expect(UPGRADE_V4_WORDS.rule).not.toMatch(/you may add|added/i)
    expect(UPGRADE_V4_WORDS.rows).toEqual({ amount: "Amount recorded", noAmountChance: "Chance with no amount" })
  })

  it("the open page: O1, O2 and O4", () => {
    expect(upgradeWinStep4(4).source).toBe(
      "Read from the open record: `open.stakedSlotIndex`, `open.stepBoostCents` (the amount recorded with the upgrade, absent when there is none), `open.stepChancePpm`, `open.stepChanceCompact`, `open.drawnSlotIndex` and `open.snapshotHash`; from the box record: the price, the chances and the buy-back values of `edition`, which fix the chance of the upgrade with that amount; from the prize list record: `snapshot.body`.",
    )
    expect(upgradeWinStep4(3).source).toBe(UPGRADE_V3_WORDS.winStep4Source)
    expect(UPGRADE_V4_WORDS.winChance(2128, 288016)).toBe(
      "Your browser computed the chance of the upgrade that made this win from the box's upgrade rate and the amount recorded with this win, 21.28: 28.80%. It is the chance shown with this win.",
    )
    expect(UPGRADE_V4_WORDS.winAmountMissing).toBe(
      "An amount may have been recorded with the upgrade but not with this win. The upgrade's own page shows its amount and checks it.",
    )
  })

  it("the two changed approved sentences name version 4 (sentences 14 and 15)", () => {
    expect(UPGRADE_V3_WORDS.unknownVersionFail).toBe(
      "This box uses another version of the upgrade rules. This page checks versions 1, 2, 3 and 4 only, so it cannot confirm this upgrade.",
    )
    expect(UPGRADE_V3_WORDS.unknownVersionChance("40.00%", "5")).toBe(
      "The chance shown with this upgraded win, 40.00%, cannot be checked: this box uses version 5 of the upgrade rules, and this page checks versions 1, 2, 3 and 4 only.",
    )
  })

  it("the library's caveats: version 4's step number reads as version 3's (sentence 24), and its win caveat says 'recorded' (25)", () => {
    expect(UPGRADE_V4_WORDS.libraryCaveats).toBe(UPGRADE_V4_CAVEATS)
    expect(UPGRADE_V4_CAVEATS.stepNo).toBe(UPGRADE_V3_CAVEATS.stepNo)
    expect(UPGRADE_V4_CAVEATS.win(0, 1, "s", 2128n)).toContain("with an amount of 21.28 recorded")
  })

  it("never says an amount was added, nor names it Moonshot or boost (SHOULD 1)", () => {
    const all = [
      ...Object.values(upgradeCheckWords(4, 9400, 2128).ok),
      ...Object.values(upgradeCheckWords(4, 9400, 2128).fail),
      ...Object.values(upgradeCheckWords(4, 9400, undefined).ok),
      ...upgradeStep2(4, 9400, 2128).text,
      upgradeStep2(4, 9400, 2128).title,
      UPGRADE_V4_WORDS.amountFail({ limit: "cap", cents: 6753, chancePpm: 500015 }, "win"),
      UPGRADE_V4_WORDS.amountFail({ limit: "reachesTarget", cents: 1 }, "win"),
      UPGRADE_V4_WORDS.malformed("upgrade"),
      UPGRADE_V4_WORDS.winStep4Source,
      UPGRADE_V4_WORDS.winChance(2128, 288016),
      UPGRADE_V4_WORDS.winAmountMissing,
      UPGRADE_V4_WORDS.rows.amount,
      UPGRADE_V4_WORDS.rows.noAmountChance,
      UPGRADE_CHECK_LABELS.boostAmount,
    ]
    // A field name in backticks is code, not a public word: `open.stepBoostCents` stays as the record writes it.
    for (const sentence of all) expect(sentence.replace(/`[^`]*`/g, "")).not.toMatch(/\badd(ed|s)?\b|moonshot|boost/i)
  })

  it("writes an amount and a refused chance exactly", () => {
    expect(amountText(2128)).toBe("21.28")
    expect(amountText(1)).toBe("0.01")
    expect(amountText(100000)).toBe("1,000.00")
    expect(amountText(100001)).toBe("1,000.01")
    expect(percentExact(500015)).toBe("50.0015%")
    expect(percentExact(500001)).toBe("50.0001%")
    expect(percentExact(9301)).toBe("0.9301%")
  })

  it("reads each of the library's refusals, and nothing else", () => {
    const fail = (expected: string, computed: string) => amountRefusal({ ok: false, expected, computed })
    expect(fail("100001 cents within the limits of version 4", "100001 cents is above the ceiling of 100000 cents")).toEqual({ limit: "ceiling", cents: 100001 })
    expect(fail("6753 cents within the limits of version 4", "6753 cents gives a chance of 500015 ppm, above the cap of 500000 ppm")).toEqual({
      limit: "cap",
      cents: 6753,
      chancePpm: 500015,
    })
    expect(fail("10 cents within the limits of version 4", "the last cent of 10 cents raises nothing: 9 cents give 9301 ppm too")).toEqual({ limit: "lastCent", cents: 10 })
    expect(fail("16000 cents within the limits of version 4", "the value staked plus 16000 cents reaches the target's value")).toEqual({ limit: "reachesTarget", cents: 16000 })
    expect(fail("no amount: version 3 of the upgrade rules has none", "2128 cents")).toEqual({ limit: "version", cents: 2128, version: "3" })
    expect(fail("amount recorded 2128 cents", "amount refused, version 3 of the upgrade rules has no amount")).toEqual({ limit: "version", cents: 2128, version: "3" })
    expect(fail("amount recorded 100001 cents", "amount refused, 100001 cents is above the ceiling of 100000 cents")).toEqual({ limit: "ceiling", cents: 100001 })
    expect(fail("chance shown 28.80%", "fair chance 18.80%")).toBeNull()
    expect(fail("1", "none: the step from slot 0 has a chance of 188000 ppm, not 288016")).toBeNull()
    expect(amountRefusal({ ok: true, expected: "no amount", computed: "no amount" })).toBeNull()
    expect(malformedAmount("expected.boostCents is wrongly formed: x")).toBe("upgrade")
    expect(malformedAmount("expected.stepBoostCents is wrongly formed: x")).toBe("win")
    expect(malformedAmount("expected.stepBoostCents is recorded only with an upgrade win, and this open is not one")).toBeNull()
  })
})

describe("a version 4 step on its page", () => {
  it("verifies box C's 21.28 step at 28.80%, with the amount's rows on card 2 (vector plus-10-won)", async () => {
    await openStep(BOX_C, v4Step(0, 1, 288016, { boostCents: 2128 }), "PASS")
    // Kills M-P4 (the step proof drops the amount: 188 000 would be the chance, and the step would fail).
    expect(card(2)).toContain("Step 2 — The chance of your upgrade comes from this box's upgrade rate and the amount recorded with it.")
    expect(card(2)).toContain(UPGRADE_V4_WORDS.rule)
    expect(card(2)).toContain(UPGRADE_V4_WORDS.casinoLimits)
    // Kills M-P3 (the amount row dropped) and M-P6 (the no-amount row showing the chance with the amount).
    expect(document.querySelector("[data-amount-row]")?.textContent).toBe("Amount recorded2128 cents (21.28)")
    expect(document.querySelector("[data-no-amount-row]")?.textContent).toBe("Chance with no amount188,000 in 1,000,000 (18.80%)")
    expect(values()).toContain("Fair chance288,016 in 1,000,000 (28.80%)")
    expect(checkText("boostAmount")).toBe(`The amount recorded: matches. ${upgradeCheckWords(4, 9400, 2128).ok.boostAmount}`)
    expect(checkText("upgradeChance")).toContain("It is the chance we recorded.")
    expect(document.querySelector("[data-check='boostAmount']")?.closest("[data-step]")?.getAttribute("data-step")).toBe("2")
  })

  it("verifies a step with no amount under version 3's title, with no amount rows (no-money-lost)", async () => {
    await openStep(BOX_C, v4Step(0, 1, 188000), "PASS")
    // Kills M-P7: the title with an amount shown on a step that records none.
    expect(card(2)).toContain("Step 2 — The chance of your upgrade comes from this box's upgrade rate.")
    expect(card(2)).not.toContain("and the amount recorded with it")
    expect(document.querySelector("[data-amount-row]")).toBeNull()
    expect(document.querySelector("[data-no-amount-row]")).toBeNull()
    expect(values()).toContain("Fair chance188,000 in 1,000,000 (18.80%)")
    expect(checkText("boostAmount")).toBe("The amount recorded: matches. No amount was recorded with this upgrade.")
  })

  const refused: [string, EditionAnswer, ReturnType<typeof v4Step>, string][] = [
    [
      "above the ceiling (40.00 to 2,000.00, 1,000.01 at 483,605)",
      BOX_A,
      v4Step(0, 3, 483605, { boostCents: 100001 }),
      "The amount recorded with this upgrade, 1,000.01, is more than 1,000.00, the most the upgrade rules allow.",
    ],
    [
      "above the cap (40.00 to 200.00, 67.53 at 500,015)",
      BOX_A,
      v4Step(0, 1, 500015, { boostCents: 6753 }),
      "With the amount recorded with this upgrade, 67.53, the chance would be 50.0015%. That is more than 50%, the most the upgrade rules allow.",
    ],
    [
      "whose last cent raised nothing (1,000.00 to 100,000.00, 0.10 at 9,301)",
      BOX_A,
      v4Step(2, 4, 9301, { boostCents: 10 }),
      "The last cent of the amount recorded with this upgrade, 0.10, did not raise the chance: 0.09 gives the same chance. The upgrade rules do not allow this.",
    ],
    [
      "that reaches the target's value (40.00 to 200.00, 160.00)",
      BOX_A,
      v4Step(0, 1, 500000, { boostCents: 16000 }),
      "The value you gave up plus the amount recorded with this upgrade, 160.00, is worth as much as the item you chose, or more. The upgrade rules do not allow this, so there is no chance to compute.",
    ],
    [
      "on version 3, which has none (box C, 21.28)",
      { ...BOX_C, editionId: "15690000-0000-4000-8000-0000000000c3", engineVersion: 3 },
      v4Step(0, 1, 188000, { engineVersion: 3, boostCents: 2128 }),
      "This upgrade records an amount, 21.28, but version 3 of the upgrade rules has no amount.",
    ],
  ]
  for (const [what, edition, step, sentence] of refused) {
    it(`fails an amount ${what} on the amount's own line`, async () => {
      await openStep(edition, step, "FAIL")
      expect(verdictLine()).toBe(`Step 2 does not match: ${sentence}`)
      expect(checkText("boostAmount")).toBe(`The amount recorded: does not match. ${sentence}`)
    })
  }

  it("fails a target under the minimum with no amount, even with an amount recorded (sentence 3b)", async () => {
    await openStep(MIN_EDGE, v4Step(0, 8, 1001, { boostCents: 1 }), "FAIL")
    expect(verdictLine()).toBe(`Step 2 does not match: ${upgradeCheckWords(4, 9300, 1).fail.upgradeTarget}`)
    expect(checkText("boostAmount")).toContain("not run")
  })

  for (const amount of ["150000", 0, 21.5, -1]) {
    it(`cannot check a step whose amount is ${JSON.stringify(amount)}, and says the record is wrongly formed`, async () => {
      await openStep(BOX_C, v4Step(0, 1, 288016, { boostCents: amount }), "CANNOT CHECK")
      expect(verdictLine()).toBe(
        `${UPGRADE_V4_WORDS.malformed("upgrade")} (expected.boostCents is wrongly formed: an amount is recorded as a whole number of cents from 1 (a JSON number, never 0 and never text), was ${typeof amount === "string" ? `the text '${amount}'` : String(amount)})`,
      )
    })
  }

  it("cannot check a version 4 step on a box under 93 %, in the plain words of version 3 (M-P8)", async () => {
    await openStep(BOX_9299 as EditionAnswer, v4Step(0, 1, 214684), "FAIL")
    expect(verdictLine()).toBe(`Step 2 cannot be checked: ${UPGRADE_V3_WORDS.underFloorCause}.`)
  })
})

describe("an upgraded win of version 4 on the open page", () => {
  it("verifies Ana's win with 21.28 recorded, and says the chance with the amount (O1, O2)", async () => {
    // Kills M-P5: the open proof drops the amount, and 288,016 is then not the chance of the step.
    await openWin(BOX_C, v4Win(0, 1, 288016, { stepBoostCents: 2128 }), "PASS")
    expect(card(4)).toContain(upgradeWinStep4(4).source.replaceAll("`", ""))
    expect(document.querySelector("[data-amount-chance]")?.textContent).toBe(UPGRADE_V4_WORDS.winChance(2128, 288016))
  })

  it("adds that the upgrade may have recorded an amount, when the win records none and the chance differs (O4)", async () => {
    // Kills M-P10. The seed is revealed: the slot's own words, then O4.
    await openWin(BOX_C, v4Win(0, 1, 288016), "FAIL")
    expect(checkText("drawnSlotIndex")).toBe(`The slot: does not match. The number lands on a different slot than the one we recorded. ${UPGRADE_V4_WORDS.winAmountMissing}`)
    expect(document.querySelector("[data-amount-chance]")).toBeNull()
  })

  it("adds O4 after the chance's words while the seed is locked", async () => {
    await openWin(BOX_C, v4Win(0, 1, 288016), "FAIL", false)
    const chance = wrongChanceWords({ kind: "shown", shown: "28.80%", fair: "18.80%" }, 4)
    expect(chance).toBe("The chance shown with this upgraded win, 28.80%, is not this box's chance rounded down to 0.01 %, which is 18.80%.")
    expect(verdictLine()).toBe(`Step 4 does not match: ${chance}`)
    expect(checkText("drawnSlotIndex")).toBe(`The slot: does not match. ${chance} ${UPGRADE_V4_WORDS.winAmountMissing}`)
  })

  for (const revealed of [true, false]) {
    it(`fails a win whose amount is above the ceiling, as the step page would (O3, seed ${revealed ? "revealed" : "locked"})`, async () => {
      await openWin(BOX_A, v4Win(0, 3, 483605, { stepBoostCents: 100001 }), "FAIL", revealed)
      const sentence = "The amount recorded with this win, 1,000.01, is more than 1,000.00, the most the upgrade rules allow."
      expect(verdictLine()).toBe(`Step 4 does not match: ${sentence}`)
      expect(checkText("drawnSlotIndex")).toBe(`The slot: does not match. ${sentence}`)
      expect(card(4)).toContain("Amount recorded with this win")
    })
  }

  it("fails a version 3 win that records an amount (O3)", async () => {
    await openWin({ ...BOX_C, editionId: "15690000-0000-4000-8000-0000000000c3", engineVersion: 3 }, v4Win(0, 1, 188000, { stepBoostCents: 2128 }), "FAIL")
    expect(verdictLine()).toBe("Step 4 does not match: This win records an amount, 21.28, but version 3 of the upgrade rules has no amount.")
  })

  it("cannot check a win whose amount is text, and says the record is wrongly formed (O5)", async () => {
    await openWin(BOX_C, v4Win(0, 1, 288016, { stepBoostCents: "2128" }), "CANNOT CHECK")
    expect(verdictLine()).toBe(
      `${UPGRADE_V4_WORDS.malformed("win")} (expected.stepBoostCents is wrongly formed: an amount is recorded as a whole number of cents from 1 (a JSON number, never 0 and never text), was the text '2128')`,
    )
  })
})

describe("the proofs carry the amount as it was written", () => {
  it("reads a step's boostCents and an open's stepBoostCents, and leaves them out when absent (M-P4, M-P5)", () => {
    const step = (extra: Record<string, unknown>) =>
      stepProofInput(
        joinStepProof({ step: JSON.stringify(v4Step(0, 1, 288016, extra)), seedPair: JSON.stringify(SEED), edition: JSON.stringify(BOX_C) }),
      )
    expect(step({ boostCents: 2128 }).expected.boostCents).toBe(2128)
    expect(step({ boostCents: "2128" }).expected.boostCents).toBe("2128")
    expect("boostCents" in step({}).expected).toBe(false)
    const open = (extra: Record<string, unknown>) =>
      proofInput(
        joinProof({ open: JSON.stringify(v4Win(0, 1, 288016, extra)), seedPair: JSON.stringify(SEED), edition: JSON.stringify(BOX_C), snapshot: null, itemId: null }),
      )
    expect(open({ stepBoostCents: 2128 }).expected.stepBoostCents).toBe(2128)
    expect(open({ stepBoostCents: 0 }).expected.stepBoostCents).toBe(0)
    expect("stepBoostCents" in open({}).expected).toBe(false)
  })
})
