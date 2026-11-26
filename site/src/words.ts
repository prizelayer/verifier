import { UPGRADE_V3_CAVEATS, UPGRADE_V4_CAVEATS, upgradeRule, type Check, type CheckName, type UpgradeStepCheckName } from "@verifier"

/** The four steps, in the words a player reads. Step 1 and step 2 never say when a value was published. */
export const STEPS = [
  {
    step: 1,
    title: "The secret we revealed is the one we registered.",
    method: "SHA-256",
    source: "Read from the seed pair record: `seedPair.serverSeedCommitment` and `seedPair.revealedServerSeed`.",
    text: [
      "For every player our server creates a secret number, and publishes its fingerprint. A fingerprint is a short code computed from the number. The same number always gives the same code, and nobody can find a different number that gives that code.",
      "After the secret is retired, our server publishes the secret itself.",
      "Your browser now computes the fingerprint of the secret we revealed. If the two are equal, the secret we revealed matches the fingerprint our server published for this pair.",
    ],
  },
  {
    step: 2,
    title: "The chances are the ones recorded on your open.",
    method: "SHA-256",
    source: "Read from the box record: `edition` (its prize table and chances), and from the open record: `open.editionFingerprint`.",
    text: [
      "A fair pick is worth nothing if the chances behind it can be swapped afterwards. So the chances of every prize in this box were frozen when the box was published, and one fingerprint was computed over all of them.",
      "Your browser rebuilds that fingerprint from the table below. If it equals the fingerprint recorded on your open, the table below is the table that fingerprint was computed from. Nobody can show you a different table with the same fingerprint.",
      "This step cannot be switched off. Without it, the rest proves nothing.",
    ],
  },
  {
    step: 3,
    title: "The pick itself.",
    method: "HMAC-SHA256",
    source:
      "Read from the seed pair record: `seedPair.revealedServerSeed` and `seedPair.clientSeed`; from the open record: `open.nonce` and `open.drawnPpmValue`.",
    text: [
      "Three things go into the pick: the secret (step 1), a second value called the client seed, and a counter that goes up by one with each open.",
      "Our server makes the client seed when it creates the seed pair. On a pair with no opens yet, the player can replace it in the player page with a random value made by the player's own browser. Either way, the client seed this open used is the one in the proof.",
      "They are mixed with a standard method. The result is 32 bytes that nobody can predict without the secret.",
      "The first 4 bytes are read as a number. If that number is too large to be shared out evenly, it is thrown away and the next 4 bytes are used. This keeps every result exactly as likely as any other.",
      "The number is then reduced to a value from 0 to 999,999. We call it v.",
    ],
  },
  {
    step: 4,
    title: "From the number to your item.",
    method: null,
    source:
      "Read from the box record: the ranges of `edition`; from the open record: `open.drawnSlotIndex` and `open.snapshotHash`; from the prize list record: `snapshot.body`. The item you received, `received.itemId`, is not a public record: it came from the link you followed.",
    text: [
      "Each prize owns a range of numbers, as wide as its chance. A prize with a 25% chance owns 250,000 of the 1,000,000 numbers.",
      "Your number v falls in exactly one range. That range is a slot. The prize list recorded for your open says which item was in that slot.",
    ],
  },
] as const

/** Step 1 while the secret is locked: no revealed secret, and no comparison claimed. */
export const STEP1_PENDING = {
  title: "The secret, when we reveal it, must be the one we registered.",
  text: [
    STEPS[0].text[0],
    "After the secret is retired, our server publishes the secret itself. The secret of this open is not published yet.",
    "When it is, your browser computes its fingerprint and checks that it is the fingerprint our server published for this pair.",
  ],
} as const

export type StepNumber = (typeof STEPS)[number]["step"]

/** A short, neutral name for each check: what it looks at, with no claim about the result. */
export const CHECK_LABELS: Record<CheckName, string> = {
  commitment: "The secret and its fingerprint",
  editionFingerprint: "The chances and their fingerprint",
  drawnPpmValue: "The number v",
  drawnSlotIndex: "The slot",
  snapshotHash: "The prize list",
  snapshotEditionLink: "The prize list's box",
  drawnItemId: "The item",
}

/** What each check means when it does not match: the sentence a FAIL verdict quotes. */
export const FAIL_WORDS: Record<CheckName, string> = {
  commitment:
    "The secret we revealed does not match the fingerprint our server published for this pair. Do not trust this result.",
  editionFingerprint:
    "The chances shown here do not match the fingerprint recorded on your open. The pick below was made against a table we cannot confirm.",
  drawnPpmValue:
    "With this secret, this client seed and this counter, the pick gives a different number than the one we recorded.",
  drawnSlotIndex: "The number lands on a different slot than the one we recorded.",
  snapshotHash: "The prize list shown here is not the one recorded on your open.",
  snapshotEditionLink: "This prize list belongs to a different box.",
  drawnItemId: "The item recorded for your win is not the item this list puts in your slot.",
}

/**
 * The steps a step's own values come from. A later step that only re-uses values of a step that
 * failed proves nothing, and says so; a step that does not use them (step 2 after step 1) does not.
 */
export const DEPENDS_ON: Record<StepNumber, readonly StepNumber[]> = { 1: [], 2: [], 3: [1], 4: [2, 3] }

export const DEPENDENT_NOTE = "This step depends on a step that failed, so it proves nothing."

/** The first-visit block, above the inputs. The header's own line already points at "What this does not prove". */
export const FIRST_VISIT = {
  heading: "How to check one of your opens",
  link:
    'In your vault, every card and every History line has a link, "Check this open yourself". It opens this page with that open\'s id already filled in. Then press "Look up".',
  noTyping:
    'You never type a seed or a box here. "Look up" fetches the public records of that open from our server: the open, its seed pair, its box and its prize list. Your browser reads the secret, the client seed and the chances from those records, and redoes the pick itself. It sends our server nothing but the open\'s id and the ids our server gives back for it.',
  pending:
    'If the secret of this open is not revealed yet, the page shows "CANNOT CHECK YET" and says when it will be. Until then your browser checks the chances (step 2) and, when the proof has one, the prize list, but not the pick itself (steps 1 and 3, and the item in step 4).',
} as const

/** Under "Paste a proof": what a proof is. */
export const PROOF_EXPLAINED =
  'A proof is the four public records of one open (the open, its seed pair, its box and its prize list), saved as one JSON text that starts with {"format": "prizelayer-proof/1". "Look up" writes it here. You can save it, and check it later, even offline.'

/**
 * "What this does not prove", paragraph 2: what the page cannot tell on its own. The player page's
 * place is named by the word a player presses, "Fair" (the header pill and the phone's tab), never by
 * a position: the position moved once, when the Details link under the Open button became the pill
 * (KAN-1052). The words are Leo's approved set; they change only with his answer (ADR-KAN-40,
 * amendment 2026-11-10).
 * Refs: KAN-40, KAN-1391
 */
export const NOT_PROVEN_SEEDS =
  'This page reads the fingerprint and the client seed from our server. On its own, it cannot tell whether you saw this fingerprint before your open, or who chose the client seed. In the player page, press "Fair" before you open a box: "Your fairness pair" shows the whole fingerprint and lets you copy it. If you kept a copy from before your open, check that it is the fingerprint in step 1. When our server creates a fingerprint for a player, it writes a record in its audit log. This page does not check that record.'

/**
 * Step 3's sentence when our record says the player set this pair's client seed. It sits after the
 * paragraph about who makes the client seed. The words are Leo's approved set, word for word (his
 * answer of 2026-10-18 on KAN-1013, D2 A); they change only with his answer.
 * Refs: KAN-935, KAN-1013
 */
export const STEP3_SEED_SET =
  "Our records say you set this pair's client seed after its fingerprint existed. If you kept the fingerprint from before you set it, we could not choose the secret to suit your seed."

/**
 * The pending verdict: what is still locked, when it opens, and what can be checked meanwhile. Where
 * "Start a new pair" is: behind "Fair", as in NOT_PROVEN_SEEDS. Approved words (ADR-KAN-40).
 * Refs: KAN-40, KAN-1391
 */
export const LOCKED =
  "The secret for this open is still locked, because it is still being used for your next opens. " +
  'It is revealed when you press "Start a new pair", or, once its pair has served 1,000 opens or is ' +
  "more than 24 hours old, at your next open or your next visit to a box page. " +
  'In the player page, press "Fair" to open "Your fairness pair": "Start a new pair" is there. ' +
  "Until then your browser can check the chances (step 2) and, when the proof has one, the prize list, " +
  "but not the pick itself."

/** The library's names for its inputs, as the fields of the pasted proof a reader can find. */
export const PROOF_FIELD: Record<string, string> = {
  serverSeedHex: "seedPair.revealedServerSeed",
  commitmentHex: "seedPair.serverSeedCommitment",
  clientSeed: "seedPair.clientSeed",
  nonce: "open.nonce",
  edition: "edition",
  snapshot: "snapshot.body",
  "snapshot.slots": "snapshot.body.slots",
  "expected.snapshotHash": "open.snapshotHash",
}

/**
 * Why a check failed because an input could not be used. It claims no comparison: a pending proof
 * with a broken commitment revealed no secret, so it must not read "the secret we revealed".
 */
export function unusableWords(field: string | undefined, error: string): string {
  return `The value ${PROOF_FIELD[field ?? ""] ?? field ?? "given"} cannot be used: ${error}.`
}

export const NOT_TOLD_ITEM = "not checked: this page was not told which item you received"
export const NO_PRIZE_LIST = "not checked: this proof has no prize list"
export const SEED_LOCKED = "not run: the secret is still locked"

/** Shown if a check stops on an error nobody planned for, instead of a page stuck at "Computing". */
export const COULD_NOT_FINISH = "The check could not finish. Nothing was checked; reload the page and try again."

/** The lookup's words, one per result (plan 3.2). */
export const LOOKUP_WORDS = {
  busy: "Fetching the public data of this open from our server (this can take up to 15 seconds)…",
  notAnId: "This is not an open id. An open id looks like 7c9e6679-7425-40de-944b-e07fc1f90ae7.",
  placeholder: "e.g. 7c9e6679-7425-40de-944b-e07fc1f90ae7",
  help: 'The id is the part after "open=" in the address of the "Check this open yourself" link. The link fills it in for you.',
  notFound: "We found no open with this id. Check the id, or paste the proof instead.",
  timedOut:
    "Our server did not answer within 15 seconds, so nothing was checked. Try again. If you saved this proof before, paste it below.",
  unreachable:
    "Your browser could not reach our server. Check your connection and try again. If you saved this proof before, paste it below: the check itself does not need our server.",
  serverFault: (message: string) =>
    `Our server sent a faulty answer, so nothing was checked: ${message}. Try again later. If you saved this proof before, paste it below.`,
  pageFault:
    "The page could not finish this lookup, so nothing was checked. Try again. If you saved this proof before, paste it below.",
  found: "We fetched the public data of this open and put it in the proof field below. The check ran in your browser.",
  sharing:
    "Anyone you give this proof or this id to can read this open, and can see how many opens were made with the same secret and when it was retired. It does not say who you are.",
} as const

/**
 * How many rows a table draws before it asks. A box with 100,000 slots took about 12 seconds to
 * draw in full, and the check itself does not need the rows on screen.
 */
export const FIRST_ROWS = 200

const rowRange = (from: number, to: number) =>
  from === to
    ? `Row ${from.toLocaleString("en")} is not drawn here.`
    : `Rows ${from.toLocaleString("en")} to ${to.toLocaleString("en")} are not drawn here.`

/**
 * The words under a cut table: the rows after the last one drawn (`from` to `to`, none when `from > to`),
 * and how many are not drawn in all. Gap markers above already named their own rows, so the total is said
 * once, as the total, and never reads as more rows on top of theirs.
 */
export const endRows = (from: number, to: number, total: number) => {
  const tail = from > to ? 0 : to - from + 1
  const range = tail === 0 ? "" : rowRange(from, to)
  if (tail === total) {
    return tail === 1
      ? `${range} Your browser used it in the check.`
      : `${range.slice(0, -1)} (${total.toLocaleString("en")} rows). Your browser used all of them in the check.`
  }
  const all = `With the rows skipped above, ${total === 1 ? "1 row is" : `${total.toLocaleString("en")} rows are`} not drawn in all.`
  const used = total === 1 ? "Your browser used it in the check." : "Your browser used all of them in the check."
  return `${range ? `${range} ` : ""}${all} ${used}`
}

/** The marker where a cut table skips rows before a row it keeps (row numbers count from 0). */
export const skippedRows = (from: number, to: number) => rowRange(from, to)

/** Drawing very many rows takes the browser a while; the button says so. */
export const SLOW_DRAW_ROWS = 20_000

/**
 * The footer: which build made this copy, and where a reader checks it. It never shows a
 * fingerprint of the page itself, because a changed page could show any number; it sends the
 * reader to two records on GitHub instead.
 */
export const FOOTER = {
  title: "Where this copy comes from",
  built: "This copy was built from commit",
  ofRepo: "of the public repository",
  byRun: "by run",
  ofWorkflow: "of its publish workflow.",
  sums:
    "That run wrote the SHA-256 fingerprint of every file it built into one list, SHA256SUMS, and printed the list in its public log. GitHub keeps that log for 90 days. GitHub Pages serves the list of the latest publish only: if a newer build was published after this copy, that list will not match these files. To check the copy you have, compute the SHA-256 of its files and compare them with the list of its own build.",
  sumsLink: "SHA256SUMS of the latest publish, on GitHub Pages",
  runLink: "the public log of this run (kept 90 days)",
  noSelfHash: "This page does not show a fingerprint of itself: a changed page could show any number.",
  notPublished:
    "This copy was not built by the publish workflow, so it names no build and no list of fingerprints. Its code is in the public repository",
} as const

// ---------------------------------------------------------------------------
// Upgrade steps (KAN-1154): a player stakes a win for a more valuable item of the box (on version 1, the next
// item up), and one pick decides it.
// ---------------------------------------------------------------------------

/** The four cards of an upgrade step. Steps 1 and 3 are the same as an open's; 2 and 4 are the step's own. */
export const UPGRADE_STEPS = [
  {
    step: 1,
    title: STEPS[0].title,
    method: "SHA-256",
    source: "Read from the seed pair record: `seedPair.serverSeedCommitment` and `seedPair.revealedServerSeed`.",
    text: STEPS[0].text,
  },
  {
    step: 2,
    title: "The chance of your upgrade is the fair one.",
    method: "SHA-256",
    source:
      "Read from the box record: `edition` (its prize table and chances); from the step record: `step.engineType`, `step.editionFingerprint`, `step.stakedSlotIndex`, `step.targetSlotIndex`, `step.chancePpm`, `step.chanceCompact` and `step.stepNo`.",
    text: [
      "An upgrade gives up the item you hold for a chance at the next item up in the same box: the next higher buy-back value, never a slot further on.",
      "The chance is fixed by the two buy-back values: the value you give up, divided by the value you could win, rounded down. Giving up 12.00 for a chance at 30.00 is a 40% chance. On average you get back what you staked, and never more, so an upgrade does not change what the box returns.",
      "Your browser checks that the box is an upgrade box, that its chances match their fingerprint, that the item offered is the next one up from yours, and that the chance is exactly that value. There is no upgrade below a 10% chance, and at most 3 in a row.",
    ],
  },
  {
    step: 3,
    title: STEPS[2].title,
    method: "HMAC-SHA256",
    source:
      "Read from the seed pair record: `seedPair.revealedServerSeed` and `seedPair.clientSeed`; from the step record: `step.nonce` and `step.drawnPpmValue`.",
    text: STEPS[2].text,
  },
  {
    step: 4,
    title: "From the number to won or lost.",
    method: null,
    source: "Read from the step record: `step.outcome`. The two ranges come from the chance checked in step 2.",
    text: [
      "An upgrade has only two ranges. The first is as wide as the chance and wins; the second holds every other number and loses. With a 40% chance, the numbers 0 to 399,999 win.",
      "Your browser reads your number v against those two ranges, not against the box's prize table, and compares the result with the one we recorded.",
    ],
  },
] as const

/**
 * Why an upgraded win's slot check failed on its chance, read from the library's words, or null for any
 * other cause. The slot's own words would then be false: no slot was compared, and the seed may still be
 * locked. The library writes "chance shown <text>" / "fair chance <text>" for a wrong text, "fair chance
 * none, slot <n> <why>" when no fair chance exists (on version 2, "slot <n> cannot step to slot <t>", or
 * "version <v> of the upgrade rules is not checked here"), and "chance recorded <n> ppm" / "fair chance <n> ppm"
 * for a recorded chance that is not the fair one. A number is read in any form a hand-made proof can carry
 * (negative, fractional), so a FAIL never falls back to the slot's words.
 */
export type WrongChance =
  | { kind: "shown"; shown: string; fair: string }
  | { kind: "none"; shown: string; slot: string; why: "offered no step" | "not in the box" }
  | { kind: "jump"; shown: string; slot: string; target: string }
  | { kind: "version"; shown: string; version: string }
  | { kind: "rate"; shown: string; why: string }
  | { kind: "recorded"; recorded: number; fair: number }

const NUMBER = String.raw`(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)`

export function wrongChanceShown(check: Check | undefined): WrongChance | null {
  if (!check || check.ok || check.expected === undefined || check.computed === undefined) return null
  const { expected, computed } = check
  const recorded = /^chance recorded (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) ppm$/.exec(expected)
  const fairPpm = /^fair chance (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) ppm$/.exec(computed)
  if (recorded && fairPpm) return { kind: "recorded", recorded: Number(recorded[1]), fair: Number(fairPpm[1]) }
  if (!expected.startsWith("chance shown ")) return null
  const shown = expected.slice("chance shown ".length)
  const none = /^fair chance none, slot (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?) is (offered no step|not in the box)$/.exec(computed)
  if (none) return { kind: "none", shown, slot: none[1], why: none[2] as "offered no step" | "not in the box" }
  // Version 2 (KAN-1567): no step from the staked slot to the slot the win records, or a version not checked.
  const jump = new RegExp(`^fair chance none, slot ${NUMBER} cannot step to slot ${NUMBER}$`).exec(computed)
  if (jump) return { kind: "jump", shown, slot: jump[1], target: jump[2] }
  const version = /^fair chance none, version (.*) of the upgrade rules is not checked here$/.exec(computed)
  if (version) return { kind: "version", shown, version: version[1] }
  // Version 3 (KAN-1751): the box's upgrade rate could not be read from the edition, so no chance exists.
  const rate = /^fair chance none, (the box returns .*|version \d+ reads the box's rate .*)$/.exec(computed)
  if (rate) return { kind: "rate", shown, why: rate[1] }
  if (!computed.startsWith("fair chance ")) return null
  return { kind: "shown", shown, fair: computed.slice("fair chance ".length) }
}

export function wrongChanceWords(cause: WrongChance, engineVersion?: number): string {
  return upgradeWords(engineVersion).wrongChance(cause)
}

/** Why an upgraded win's chance failed, on versions 1 and 2: "the fair chance". */
function fairWrongChance(cause: WrongChance): string {
  switch (cause.kind) {
    case "shown":
      return `The chance shown with this upgraded win, ${cause.shown}, is not its fair chance rounded down to 0.01 %, which is ${cause.fair}.`
    case "none":
      return cause.why === "offered no step"
        ? `The chance shown with this upgraded win, ${cause.shown}, cannot be a fair chance: the item given up, in slot ${cause.slot}, has no item above it in this box, so no upgrade is offered from it.`
        : `The chance shown with this upgraded win, ${cause.shown}, cannot be a fair chance: the item given up names slot ${cause.slot}, and this box has no slot ${cause.slot}.`
    case "jump":
      return `The chance shown with this upgraded win, ${cause.shown}, cannot be a fair chance: this box allows no upgrade from the item in slot ${cause.slot} to the item in slot ${cause.target}.`
    case "version":
      return UPGRADE_V3_WORDS.unknownVersionChance(cause.shown, cause.version)
    case "rate":
      return UPGRADE_V3_WORDS.rateChance(cause.shown, cause.why)
    case "recorded":
      return `The chance recorded with this upgraded win, ${cause.recorded.toLocaleString("en")} in 1,000,000, is not its fair chance, ${cause.fair.toLocaleString("en")} in 1,000,000.`
  }
}

/** The library's own list, so a check it adds cannot reach the page without its words (each Record below). */
export type UpgradeStepName = UpgradeStepCheckName

/** The step card each step check belongs to. */
export const UPGRADE_STEP_OF: Record<UpgradeStepName, StepNumber> = {
  commitment: 1,
  editionFingerprint: 2,
  engineType: 2,
  engineVersion: 2,
  upgradeTarget: 2,
  upgradeChance: 2,
  chanceCompact: 2,
  stepNo: 2,
  boostAmount: 2,
  drawnPpmValue: 3,
  upgradeOutcome: 4,
}

export const UPGRADE_CHECK_LABELS: Record<UpgradeStepName, string> = {
  commitment: CHECK_LABELS.commitment,
  editionFingerprint: CHECK_LABELS.editionFingerprint,
  engineType: "The kind of box",
  engineVersion: "The version of the upgrade rules",
  upgradeTarget: "The item offered",
  upgradeChance: "The chance",
  chanceCompact: "The chance shown to you",
  stepNo: "How many upgrades in a row",
  boostAmount: "The amount recorded",
  drawnPpmValue: CHECK_LABELS.drawnPpmValue,
  upgradeOutcome: "Won or lost",
}

/** What each step check means when it matches. */
export const UPGRADE_CHECK_WORDS: Record<UpgradeStepName, string> = {
  commitment: "The secret we revealed matches the fingerprint our server published for this pair.",
  editionFingerprint: "The chances match the fingerprint recorded on your upgrade.",
  engineType: "The box is an upgrade box.",
  engineVersion: "The box uses version 1 of the upgrade rules, the version this page checks.",
  upgradeTarget: "The item offered is the next one up from the item you gave up.",
  upgradeChance: "The chance is the value you gave up divided by the value offered, rounded down.",
  chanceCompact: "The percent you were shown is this fair chance, rounded down to 0.01 %.",
  stepNo: "This upgrade is within the 3 a win may take.",
  boostAmount: "This version of the upgrade rules has no amount, and none was recorded with this upgrade.",
  drawnPpmValue: "The pick, redone from the secret, the client seed and the counter, gives the number we recorded.",
  upgradeOutcome: "That number gives the result we recorded.",
}

/** What each step check means when it does not match. */
/**
 * KAN-1751 (listed in UPGRADE_V3_WORDS). One of the two sentences for a version this page does not check: they
 * name version 3 since KAN-1751, and version 4 since KAN-1569 (sentence 14 of plan v1.1 §3.3).
 */
const UPGRADE_UNKNOWN_VERSION_FAIL =
  "This box uses another version of the upgrade rules. This page checks versions 1, 2, 3 and 4 only, so it cannot confirm this upgrade."

export const UPGRADE_FAIL_WORDS: Record<UpgradeStepName, string> = {
  commitment: FAIL_WORDS.commitment,
  editionFingerprint:
    "The chances shown here do not match the fingerprint recorded on your upgrade. The step below was checked against a table we cannot confirm.",
  engineType: "This box is not an upgrade box, so it offers no upgrade.",
  engineVersion: UPGRADE_UNKNOWN_VERSION_FAIL,
  upgradeTarget: "The item offered is not the next one up from the item you gave up.",
  upgradeChance: "The chance we recorded is not the fair chance of this upgrade.",
  chanceCompact: "The percent you were shown is not this fair chance, rounded down to 0.01 %.",
  stepNo: "This would be more upgrades in a row than a win may take.",
  boostAmount: "This upgrade records an amount, but this version of the upgrade rules has no amount.",
  drawnPpmValue: FAIL_WORDS.drawnPpmValue,
  upgradeOutcome: "With the fair chance, this number gives a different result than the one we recorded.",
}

/**
 * The row naming the item a step aims at, on card 2. Version 1 steps only to the next value up. Any other
 * version lets a step name its own target, so its row says no more than that.
 * Refs: KAN-1567
 */
export const UPGRADE_TARGET_ROW = { nextUp: "Next item up", target: "Target item" } as const

/**
 * The words that differ on version 2, where a step may name any more valuable item of the box at 1 % or
 * more. Every other word of a step is the same on both versions, and version 1 keeps the words above.
 * Refs: KAN-1567
 */
export const UPGRADE_JUMP_WORDS = {
  step2Text: [
    "An upgrade gives up the item you hold for a chance at a more valuable item in the same box: the item you chose, not only the next one up.",
    UPGRADE_STEPS[1].text[1],
    "Your browser checks that the box is an upgrade box, that its chances match their fingerprint, that the item you chose is worth more than yours, and that the chance is exactly that value. There is no upgrade below a 1% chance, and at most 3 in a row.",
  ],
  checkWords: {
    engineVersion: "The box uses version 2 of the upgrade rules, a version this page checks.",
    upgradeTarget: "The item you chose is worth more than the item you gave up, at a chance of 1% or more.",
  },
  failWords: {
    upgradeTarget: "The item you chose is not one this upgrade allows: it must be worth more than the item you gave up, at a chance of 1% or more.",
  },
  labels: {
    upgradeTarget: "The item you chose",
  },
  /** Under the PASS of an upgraded win: the win records its own item, which this page does not compare with the upgrade's. */
  winPassCaveat:
    "This page did not check the item given up for this upgrade, the kind of box, how many upgrades came in a row, or that this is the item the upgrade aimed at. The upgrade's own check covers the first three. It also names the item the upgrade aimed at: compare it with the item on this page.",
  /** Card 4 of an upgraded win: the browser checked the slot the win records, it did not find one. */
  winSlotLabel: "Slot your browser checked",
} as const

/**
 * Whether a step on this edition's version may name its own target. The library's version table decides,
 * so a new version is added in one place; an edition with no version, or one the library does not check,
 * gets version 1's words.
 */
export function stepJumps(engineVersion: number | undefined): boolean {
  return engineVersion !== undefined && upgradeRule(engineVersion)?.jumps === true
}

/** The labels and the words of a step's checks, one entry for each check the library makes. */
export interface UpgradeCheckWordSet {
  labels: Record<UpgradeStepName, string>
  ok: Record<UpgradeStepName, string>
  fail: Record<UpgradeStepName, string>
}

/**
 * Every word a page shows that depends on the version of the upgrade rules. One entry per version in
 * {@link UPGRADE_WORDS_BY_VERSION}, so a version is never worded with another version's text.
 * `amountCents` is the amount the record carries, absent when it carries none.
 */
export interface UpgradeVersionWords {
  checks(rateBps: number | undefined, amountCents: number | undefined): UpgradeCheckWordSet
  step2(rateBps: number | undefined, amountCents: number | undefined): { title: string; text: readonly string[] }
  wrongChance(cause: WrongChance): string
  /** The labels of the two chances an upgraded win's slot check compares. */
  compareLabels: { recorded: string; shown: string }
  /** Card 4 of the open page for an upgraded win. */
  winStep4: { title: string; source: string; text: readonly string[] }
  /** Whether the version reads the box's rate, so a box under the floor gets one plain cause. */
  readsRate: boolean
  /** Whether a step on this version may record an amount (version 4). */
  recordsAmount: boolean
}

/** The labels and words of a step's checks for an edition on `engineVersion`, with the amount its step records. */
export function upgradeCheckWords(engineVersion: number | undefined, rateBps?: number, amountCents?: number): UpgradeCheckWordSet {
  return upgradeWords(engineVersion).checks(rateBps, amountCents)
}

/** Card 2 of a step on `engineVersion`: its title and its text. */
export function upgradeStep2(engineVersion: number | undefined, rateBps?: number, amountCents?: number): { title: string; text: readonly string[] } {
  return upgradeWords(engineVersion).step2(rateBps, amountCents)
}

/** The labels of the two chances an upgraded win's slot check compares, by version. */
export function wrongChanceLabels(engineVersion: number | undefined): { recorded: string; shown: string } {
  return upgradeWords(engineVersion).compareLabels
}

/**
 * The note on a step checked under the demo rules of 17 and 18 November 2026 (KAN-1751 plan v1.2 D3 A). Only a dev
 * build has a list of such steps (demo-steps.json), so no production page can show it. Approved in the owner's
 * decisions of 2026-11-20 (KAN-1751); dev only, it is deleted with the list at dev's next reset.
 */
export const DEMO_STEP_NOTE =
  "This upgrade was checked under the demo rules of 17 and 18 November 2026. On those two days the dev site drew some upgrades at 93 % of their usual chance, and this dev page has the list of them. Every other upgrade is checked under its own version's rule."

// ---------------------------------------------------------------------------
// Version 3 of the upgrade (KAN-1751).
//
// Every sentence a person reads only for a version 3 step or win is in this one table, with the library's
// two version 3 caveats (UPGRADE_V3_CAVEATS), so the whole list can be read in one place.
//
// Every sentence here is the owner's, approved word for word in two decisions of 2026-11-20 (KAN-1751).
// The first approved four texts: text 3 is card 2's second paragraph; text 4 its third paragraph; text 5
// the first sentence of the `upgradeChance` check line and its fail line; text 6 the second sentence of that
// check line, and `underFloorCause`, which the page shows after its own prefix "Step 2 cannot be checked: ".
// The example in text 3 keeps "96.36 %" whatever the box. The second approved every other new or changed
// sentence of this series, 19 in all: among them card 2's title, the other check and fail lines, the compare
// labels, the win causes, the variant of text 3 for a box whose rate cannot be read, the card 4 source line,
// the library's two caveats and the dev page's demo note. upgrade-v3.test.tsx pins the four texts and the
// title word for word. A change to any sentence here is a new decision of the owner.
//
// The rule of every sentence (plan §19): the rate is the box's return rounded down to 0.01 %, and
// at most 99.90 %; an upgrade gives back at least the RATE, never "the box's return".
// ---------------------------------------------------------------------------

/** A step rate in basis points as the page writes it: two decimals and a space, "96.36 %" (plan O-6 A). */
export function rateText(rateBps: number): string {
  return `${Math.trunc(rateBps / 100)}.${String(rateBps % 100).padStart(2, "0")} %`
}

export const UPGRADE_V3_WORDS = {
  libraryCaveats: UPGRADE_V3_CAVEATS,
  unknownVersionFail: UPGRADE_UNKNOWN_VERSION_FAIL,
  unknownVersionChance: (shown: string, version: string): string =>
    `The chance shown with this upgraded win, ${shown}, cannot be checked: this box uses version ${version} of the upgrade rules, and this page checks versions 1, 2, 3 and 4 only.`,
  rateChance: (shown: string, why: string): string =>
    UPGRADE_V3_WORDS.underFloor(why)
      ? `The chance shown with this upgraded win, ${shown}, cannot be checked: ${UPGRADE_V3_WORDS.underFloorCause}.`
      : `The chance shown with this upgraded win, ${shown}, cannot be checked: this box's upgrade rate cannot be read from its chances and its price (${why}).`,

  /**
   * A box under 93 % (the library's "the box returns <n> bps, under the 9300 bps floor"): one plain cause
   * for the sentences a person reads; the number stays in the check row, which shows the library's text.
   * A version 3 box whose price is not positive is a broken record, and keeps the library's own message.
   */
  underFloor: (message: string | undefined): boolean => message !== undefined && /^the box returns \d+ bps, under the \d+ bps floor of version (3|4)/.test(message),
  underFloorCause: "this box returns less than 93 %, which is not allowed for a box with upgrades",

  /**
   * Card 2. Item 1 of §19 with the box's rate; when the rate could not be read (a box under 93 %), the same
   * rule with "that rate" in place of the number, so no sentence states a rate the page does not have.
   */
  step2: (rateBps: number | undefined): { title: string; text: readonly string[] } => {
    const rate = rateBps === undefined ? undefined : rateText(rateBps)
    return {
      title: "The chance of your upgrade comes from this box's upgrade rate.",
      text: [
        "An upgrade gives up the item you hold for a chance at a more valuable item in the same box: the item you chose, not only the next one up.",
        rate === undefined
          ? "The chance is fixed by the two buy-back values and the box's upgrade rate. The upgrade rate is the box's return, rounded down to 0.01 %, and at most 99.90 %, and it is never under 93 %. The chance is that rate times the value you give up, divided by the value you could win, rounded up to a millionth. On a box whose upgrade rate is 96.36 %, giving up 10.00 for a chance at 20.00 is a 48.18% chance. On average you get back at least that rate of what you staked."
          : `The chance is fixed by the two buy-back values and the box's upgrade rate. The upgrade rate is the box's return, rounded down to 0.01 %, and at most 99.90 %; on this box it is ${rate}, and it is never under 93 %. The chance is ${rate} times the value you give up, divided by the value you could win, rounded up to a millionth. On a box whose upgrade rate is 96.36 %, giving up 10.00 for a chance at 20.00 is a 48.18% chance. On average you get back at least ${rate} of what you staked.`,
        "Your browser checks that the box is an upgrade box, that its chances match their fingerprint, that the item offered is a more valuable one in the same box, and that the chance is the box's upgrade rate times the value staked, divided by the value of the item offered, rounded up to a millionth. Your browser works out the upgrade rate itself, from the box's chances and its price: it is the box's return, rounded down to 0.01 %, and at most 99.90 %. There is no upgrade below a 0.10% chance. There is no limit on upgrades in a row: a chain ends at the most valuable prize of the box.",
      ],
    }
  },

  /** The check lines that differ from version 2's (items 3 and 4 of §19 for the chance). */
  checks: (rateBps: number | undefined): { ok: Partial<Record<UpgradeStepName, string>>; fail: Partial<Record<UpgradeStepName, string>> } => ({
    ok: {
      engineVersion: "The box uses version 3 of the upgrade rules, a version this page checks.",
      upgradeTarget: "The item you chose is worth more than the item you gave up, at a chance of 0.10% or more.",
      upgradeChance:
        rateBps === undefined
          ? "The chance is this box's upgrade rate times the value you gave up, divided by the value offered, rounded up to a millionth."
          : `The chance is this box's upgrade rate, ${rateText(rateBps)}, times the value you gave up, divided by the value offered, rounded up to a millionth. The box's upgrade rate, ${rateText(rateBps)}, is worked out by your browser from the box's chances and its price: the box's return, rounded down to 0.01 %, and at most 99.90 %.`,
      chanceCompact: "The percent you were shown is this chance, rounded down to 0.01 %.",
      stepNo: "This upgrade's number is at most 29: there is no limit on upgrades in a row, and a box of at most 30 items allows no longer chain.",
    },
    fail: {
      upgradeTarget: "The item you chose is not one this upgrade allows: it must be worth more than the item you gave up, at a chance of 0.10% or more.",
      upgradeChance: "The chance we recorded is not this box's chance for this upgrade.",
      chanceCompact: "The percent you were shown is not this chance, rounded down to 0.01 %.",
      stepNo: "This would be more upgrades in a row than a box of at most 30 items allows.",
      upgradeOutcome: "With this box's chance, this number gives a different result than the one we recorded.",
    },
  }),

  /**
   * Card 4's source line of an upgraded win: on version 3 the price and the chances fix the chance too,
   * through the rate, and the chance is not the fair one.
   */
  winStep4Source:
    "Read from the open record: `open.stakedSlotIndex`, `open.stepChancePpm`, `open.stepChanceCompact`, `open.drawnSlotIndex` and `open.snapshotHash`; from the box record: the price, the chances and the buy-back values of `edition`, which fix the chance of the upgrade; from the prize list record: `snapshot.body`.",

  /** The two chances an upgraded win's slot check compares. */
  compareLabels: { recorded: "This box's chance", shown: "This box's chance, rounded down" },

  /** Why an upgraded win's chance failed, on version 3: "this box's chance", never "the fair chance". */
  wrongChance: (cause: WrongChance): string => {
    switch (cause.kind) {
      case "shown":
        return `The chance shown with this upgraded win, ${cause.shown}, is not this box's chance rounded down to 0.01 %, which is ${cause.fair}.`
      case "none":
        return cause.why === "offered no step"
          ? `The chance shown with this upgraded win, ${cause.shown}, cannot be this box's chance: the item given up, in slot ${cause.slot}, has no item above it in this box, so no upgrade is offered from it.`
          : `The chance shown with this upgraded win, ${cause.shown}, cannot be this box's chance: the item given up names slot ${cause.slot}, and this box has no slot ${cause.slot}.`
      case "jump":
        return `The chance shown with this upgraded win, ${cause.shown}, cannot be this box's chance: this box allows no upgrade from the item in slot ${cause.slot} to the item in slot ${cause.target}.`
      case "version":
        return UPGRADE_V3_WORDS.unknownVersionChance(cause.shown, cause.version)
      case "rate":
        return UPGRADE_V3_WORDS.rateChance(cause.shown, cause.why)
      case "recorded":
        return `The chance recorded with this upgraded win, ${cause.recorded.toLocaleString("en")} in 1,000,000, is not this box's chance, ${cause.fair.toLocaleString("en")} in 1,000,000.`
    }
  },
}

/** The verdict lines of a step. A lost step that checks out is a PASS of the check, never a celebration. */
export const UPGRADE_VERDICT = {
  won: "Your browser recomputed this upgrade from the data above and got the same result we recorded: the upgrade was won.",
  lost: "Your browser recomputed this upgrade from the data above and got the same result we recorded: the upgrade was lost, and the item you gave up is gone.",
} as const

/**
 * Card 4 of the open page for an upgraded win: the step's title and text, since the number was read over
 * the step's two ranges, never the box's. Its source names the open proof's own fields.
 */
export const UPGRADE_WIN_STEP4 = {
  title: UPGRADE_STEPS[3].title,
  source:
    "Read from the open record: `open.stakedSlotIndex`, `open.stepChancePpm`, `open.stepChanceCompact`, `open.drawnSlotIndex` and `open.snapshotHash`; from the box record: the buy-back values of `edition`, which fix the fair chance; from the prize list record: `snapshot.body`.",
  text: UPGRADE_STEPS[3].text,
} as const

/** Card 4 of an upgraded win on `engineVersion`: on versions 3 and 4 its source line names what fixes that chance. */
export function upgradeWinStep4(engineVersion: number | undefined): { title: string; source: string; text: readonly string[] } {
  return upgradeWords(engineVersion).winStep4
}

/** Under the open verdict, when the win was made by an upgrade. */
export const UPGRADE_WIN = {
  note: "This win was made by an upgrade. Its number is read against the upgrade's two ranges, not against the box's prize table.",
  /** Under a PASS only: what the open's check leaves to the upgrade's own check (the library's caveat). */
  passCaveat:
    "This page did not check the item given up for this upgrade, the kind of box, or how many upgrades came in a row. The upgrade's own check covers those.",
  link: "Check the upgrade that made this win",
} as const

/** Under "Paste a proof": the second kind of proof. */
export const STEP_PROOF_EXPLAINED =
  'An upgrade has its own proof: its three public records (the upgrade, its seed pair and its box), saved as one JSON text that starts with {"format": "prizelayer-step-proof/1".'

/** The pending verdict of an upgrade: the same lock as an open's, said of the upgrade. */
export const STEP_LOCKED = LOCKED.replace("The secret for this open", "The secret for this upgrade")

/** The lookup's words for an upgrade. */
export const STEP_LOOKUP_WORDS = {
  kindOpen: "An open",
  kindStep: "An upgrade",
  label: "Look up an upgrade by its id",
  help: 'The id is the part after "step=" in the address of the "Check this upgrade yourself" link. The link fills it in for you.',
  notAnId: "This is not an upgrade id. An upgrade id looks like 7c9e6679-7425-40de-944b-e07fc1f90ae7.",
  notFound: "We found no upgrade with this id. An item that was never upgraded has none.",
  found: "We fetched the public data of this upgrade and put it in the proof field below. The check ran in your browser.",
} as const

/**
 * A step chance in percent, rounded DOWN to two decimals, so it is never shown above the true chance (owner ruling, KAN-1154).
 * The same string as the server's `chanceCompact` (platform DisplayRounding.renderFloor), "< 0.01%" below 100 ppm
 * included; a step never goes under 1 % (10 % on version 1), but the two must not differ anywhere.
 */
export function percentDown(ppm: number): string {
  if (ppm < 100) return "< 0.01%"
  const hundredths = Math.floor(ppm / 100)
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}%`
}

// ---------------------------------------------------------------------------
// Version 4 of the upgrade (KAN-1569): a step may record an amount of money with the value given up.
//
// Every sentence a person reads only for a version 4 step or win is in this one table, with the library's
// two version 4 caveats (UPGRADE_V4_CAVEATS). The numbers in the comments are those of plan v1.1 §3.3.
// DRAFTS: the words are the player owner's, and Leo approves them with the merge answer.
//
// The rules of every sentence (the cto's go, Jira 37016): an amount is "recorded", never "added", because
// the check reads the record and never a wallet (SHOULD 1); a wrongly formed amount is said to be wrongly
// formed, never "not checked yet" (SHOULD 5); and the rule paragraph states what the upgrade rules allow,
// never "you may add", because a casino may switch the amount off (SHOULD 6). No sentence says something
// the check does not do (cto 37014).
// ---------------------------------------------------------------------------

/** An amount in cents as the page writes a value in a sentence: "21.28", "1,000.00", no currency sign. */
export function amountText(cents: number): string {
  const whole = Math.trunc(cents / 100).toLocaleString("en")
  return `${whole}.${String(cents % 100).padStart(2, "0")}`
}

/** A chance to the millionth, never rounded: 500 015 ppm is "50.0015%", so a refused chance never reads as 50%. */
export function percentExact(ppm: number): string {
  return `${Math.trunc(ppm / 10_000)}.${String(ppm % 10_000).padStart(4, "0")}%`
}

/** Which record a sentence speaks of: the step's own page, or the open page of the win it made. */
export type AmountSubject = "upgrade" | "win"

/**
 * A recorded amount the library refused, read from its words, or null for any other check. The library writes
 * the limit (`boostLimitWhy` in src/verifier.ts) as the step's `boostAmount` computed text, and behind
 * "amount refused, " as the computed text of an upgraded win's slot check. On a version with no amount the
 * step writes expected "no amount: version <v> of the upgrade rules has none" and computed "<b> cents"; the
 * win writes "amount refused, version <v> of the upgrade rules has no amount", with expected
 * "amount recorded <b> cents".
 */
export type AmountRefusal =
  | { limit: "reachesTarget"; cents: number }
  | { limit: "ceiling"; cents: number }
  | { limit: "cap"; cents: number; chancePpm: number }
  | { limit: "lastCent"; cents: number }
  | { limit: "version"; cents: number; version: string }

export function amountRefusal(check: Check | undefined): AmountRefusal | null {
  if (!check || check.ok || check.error !== undefined || check.expected === undefined || check.computed === undefined) return null
  const { expected, computed } = check
  const noAmount = /^no amount: version (\d+) of the upgrade rules has none$/.exec(expected)
  const stepCents = /^(\d+) cents$/.exec(computed)
  if (noAmount && stepCents) return { limit: "version", cents: Number(stepCents[1]), version: noAmount[1] }
  const recorded = /^amount recorded (\d+) cents$/.exec(expected)
  const winVersion = /^amount refused, version (\d+) of the upgrade rules has no amount$/.exec(computed)
  if (recorded && winVersion) return { limit: "version", cents: Number(recorded[1]), version: winVersion[1] }
  const why = computed.startsWith("amount refused, ") ? computed.slice("amount refused, ".length) : computed
  const reaches = /^the value staked plus (\d+) cents reaches the target's value$/.exec(why)
  if (reaches) return { limit: "reachesTarget", cents: Number(reaches[1]) }
  const ceiling = /^(\d+) cents is above the ceiling of \d+ cents$/.exec(why)
  if (ceiling) return { limit: "ceiling", cents: Number(ceiling[1]) }
  const cap = /^(\d+) cents gives a chance of (\d+) ppm, above the cap of \d+ ppm$/.exec(why)
  if (cap) return { limit: "cap", cents: Number(cap[1]), chancePpm: Number(cap[2]) }
  const lastCent = /^the last cent of (\d+) cents raises nothing: \d+ cents give \d+ ppm too$/.exec(why)
  if (lastCent) return { limit: "lastCent", cents: Number(lastCent[1]) }
  return null
}

/**
 * The library's message for a wrongly formed amount ("expected.boostCents is wrongly formed: …" on a step,
 * "expected.stepBoostCents is wrongly formed: …" on an open), or null for any other message.
 */
export function malformedAmount(message: string | undefined): AmountSubject | null {
  if (message === undefined) return null
  if (message.startsWith("expected.boostCents is wrongly formed")) return "upgrade"
  if (message.startsWith("expected.stepBoostCents is wrongly formed")) return "win"
  return null
}

export const UPGRADE_V4_WORDS = {
  libraryCaveats: UPGRADE_V4_CAVEATS,

  /** The check lines that differ from version 3's (sentences 1 to 6, 3b and 22). */
  checks: (rateBps: number | undefined, amountCents: number | undefined): { ok: Partial<Record<UpgradeStepName, string>>; fail: Partial<Record<UpgradeStepName, string>> } => ({
    ok: {
      engineVersion: "The box uses version 4 of the upgrade rules, a version this page checks.",
      upgradeTarget: "The item you chose is worth more than the item you gave up, at a chance of 0.10% or more with no amount.",
      // With no amount the chance is version 3's, so its approved line holds word for word.
      upgradeChance:
        amountCents === undefined
          ? (UPGRADE_V3_WORDS.checks(rateBps).ok.upgradeChance as string)
          : `Your browser computed the chance from this box's upgrade rate${rateBps === undefined ? "" : `, ${rateText(rateBps)},`} and the amount recorded with this upgrade. It is the chance we recorded.`,
      boostAmount:
        amountCents === undefined
          ? "No amount was recorded with this upgrade."
          : `The amount recorded with this upgrade, ${amountText(amountCents)}, is within the limits of the upgrade rules. It is at most 1,000.00, and the chance with it is at most 50%. Its last cent raised the chance, so no smaller amount gives the same chance.`,
    },
    fail: {
      upgradeTarget:
        "The item you chose is not one this upgrade allows: it must be worth more than the item you gave up, at a chance of 0.10% or more with no amount. An amount recorded with the upgrade does not change this.",
      // Shown only if the library's words for a refused amount could not be read (amountFail reads them).
      boostAmount: "The amount recorded with this upgrade is not one the upgrade rules allow.",
    },
  }),

  /** Card 2: its title (sentences 11 and 11b) and its text: version 3's first two paragraphs, then 12, 12b and 23. */
  step2: (rateBps: number | undefined, amountCents: number | undefined): { title: string; text: readonly string[] } => {
    const v3 = UPGRADE_V3_WORDS.step2(rateBps)
    return {
      title: amountCents === undefined ? v3.title : "The chance of your upgrade comes from this box's upgrade rate and the amount recorded with it.",
      text: [
        v3.text[0],
        v3.text[1],
        UPGRADE_V4_WORDS.rule,
        UPGRADE_V4_WORDS.checksParagraph,
        UPGRADE_V4_WORDS.casinoLimits,
      ],
    }
  },

  /** Sentence 12: the rule, as the upgrade rules state it (SHOULD 6). The example is box C of ADR-KAN-1154 §9.8. */
  rule: "The upgrade rules allow an amount from 0.01 to 1,000.00 EUR to be recorded with an upgrade. With an amount, the chance is the upgrade rate times the value you give up plus the amount, divided by the value you could win, rounded up to a millionth. The chance with an amount is at most 50%. The last cent of the amount must raise the chance. On a box whose upgrade rate is 94.00 %, giving up 40.00 with an amount of 21.28 for a chance at 200.00 is a 28.80% chance.",

  /**
   * Sentence 12b, not on the plan's list: version 3's third paragraph says the chance is the rate times the
   * value staked, which is false for a step with an amount, so version 4 has its own.
   */
  checksParagraph:
    "Your browser checks that the box is an upgrade box, that its chances match their fingerprint, and that the item offered is a more valuable one in the same box. It checks that the chance is the box's upgrade rate times the value staked plus the amount recorded, divided by the value of the item offered, rounded up to a millionth. It checks that the amount is within the limits of the upgrade rules. Your browser works out the upgrade rate itself, from the box's chances and its price: it is the box's return, rounded down to 0.01 %, and at most 99.90 %. There is no upgrade below a 0.10% chance with no amount. There is no limit on upgrades in a row: a chain ends at the most valuable prize of the box.",

  /** Sentence 23: what the check cannot see. */
  casinoLimits:
    "A casino may set lower limits on the amount than the upgrade rules do. Those limits are not in the upgrade's record, so this page checks only the limits of the upgrade rules.",

  /** Sentence 13: the two rows card 2's table gains on a step with an amount. */
  rows: { amount: "Amount recorded", noAmountChance: "Chance with no amount" },

  /** Sentences 7, 8, 9, 10 and 20 on the step page; O3 with "this win" on the open page. */
  amountFail: (refusal: AmountRefusal, subject: AmountSubject): string => {
    const amount = amountText(refusal.cents)
    switch (refusal.limit) {
      case "ceiling":
        return `The amount recorded with this ${subject}, ${amount}, is more than 1,000.00, the most the upgrade rules allow.`
      case "cap":
        return `With the amount recorded with this ${subject}, ${amount}, the chance would be ${percentExact(refusal.chancePpm)}. That is more than 50%, the most the upgrade rules allow.`
      case "lastCent":
        return `The last cent of the amount recorded with this ${subject}, ${amount}, did not raise the chance: ${amountText(refusal.cents - 1)} gives the same chance. The upgrade rules do not allow this.`
      case "version":
        return `This ${subject} records an amount, ${amount}, but version ${refusal.version} of the upgrade rules has no amount.`
      case "reachesTarget":
        return `The value you gave up plus the amount recorded with this ${subject}, ${amount}, is worth as much as the item you chose, or more. The upgrade rules do not allow this, so there is no chance to compute.`
    }
  },

  /** Sentence 21 on the step page, O5 on the open page: a CANNOT CHECK that is not a "not yet" (SHOULD 5). */
  malformed: (subject: AmountSubject): string =>
    `The record of this ${subject} is wrongly formed: the amount recorded with it is not a whole number of cents of 0.01 or more. This page cannot check a record in this shape.`,

  /** O1: card 4's source line of an upgraded win on version 4. */
  winStep4Source:
    "Read from the open record: `open.stakedSlotIndex`, `open.stepBoostCents` (the amount recorded with the upgrade, absent when there is none), `open.stepChancePpm`, `open.stepChanceCompact`, `open.drawnSlotIndex` and `open.snapshotHash`; from the box record: the price, the chances and the buy-back values of `edition`, which fix the chance of the upgrade with that amount; from the prize list record: `snapshot.body`.",

  /** O2: under card 4 of an upgraded win whose open record carries an amount, when its slot check matched. */
  winChance: (amountCents: number, chancePpm: number): string =>
    `Your browser computed the chance of the upgrade that made this win from the box's upgrade rate and the amount recorded with this win, ${amountText(amountCents)}: ${percentDown(chancePpm)}. It is the chance shown with this win.`,

  /** O4: after the failure sentence of an upgraded win whose open record carries no amount. */
  winAmountMissing:
    "An amount may have been recorded with the upgrade but not with this win. The upgrade's own page shows its amount and checks it.",
}

/** The failure sentence of one step check: a refused amount in its own words, any other check by its version's words. */
export function stepFailWords(name: UpgradeStepName, check: Check | undefined, words: UpgradeCheckWordSet): string {
  const refusal = name === "boostAmount" ? amountRefusal(check) : null
  return refusal ? UPGRADE_V4_WORDS.amountFail(refusal, "upgrade") : words.fail[name]
}

/** The line of a CANNOT CHECK: a wrongly formed amount says so, with the library's reason; any other keeps the library's. */
export function invalidWords(message: string | undefined, summary: string): string {
  const subject = malformedAmount(message)
  return subject === null ? (message ?? summary) : `${UPGRADE_V4_WORDS.malformed(subject)} (${message})`
}

// ---------------------------------------------------------------------------
// The words of each version, in one table (KAN-1569 plan v1.1 S1).
// ---------------------------------------------------------------------------

const FAIR_COMPARE_LABELS = { recorded: "Fair chance", shown: "Fair chance, rounded down" } as const

const V1_WORDS: UpgradeVersionWords = {
  checks: () => ({ labels: UPGRADE_CHECK_LABELS, ok: UPGRADE_CHECK_WORDS, fail: UPGRADE_FAIL_WORDS }),
  step2: () => ({ title: UPGRADE_STEPS[1].title, text: UPGRADE_STEPS[1].text }),
  wrongChance: fairWrongChance,
  compareLabels: FAIR_COMPARE_LABELS,
  winStep4: UPGRADE_WIN_STEP4,
  readsRate: false,
  recordsAmount: false,
}

const V2_WORDS: UpgradeVersionWords = {
  ...V1_WORDS,
  checks: () => ({
    labels: { ...UPGRADE_CHECK_LABELS, ...UPGRADE_JUMP_WORDS.labels },
    ok: { ...UPGRADE_CHECK_WORDS, ...UPGRADE_JUMP_WORDS.checkWords },
    fail: { ...UPGRADE_FAIL_WORDS, ...UPGRADE_JUMP_WORDS.failWords },
  }),
  step2: () => ({ title: UPGRADE_STEPS[1].title, text: UPGRADE_JUMP_WORDS.step2Text }),
}

const V3_WORDS: UpgradeVersionWords = {
  checks: (rateBps) => {
    const v3 = UPGRADE_V3_WORDS.checks(rateBps)
    return {
      labels: { ...UPGRADE_CHECK_LABELS, ...UPGRADE_JUMP_WORDS.labels },
      ok: { ...UPGRADE_CHECK_WORDS, ...UPGRADE_JUMP_WORDS.checkWords, ...v3.ok },
      fail: { ...UPGRADE_FAIL_WORDS, ...UPGRADE_JUMP_WORDS.failWords, ...v3.fail },
    }
  },
  step2: (rateBps) => UPGRADE_V3_WORDS.step2(rateBps),
  wrongChance: UPGRADE_V3_WORDS.wrongChance,
  compareLabels: UPGRADE_V3_WORDS.compareLabels,
  winStep4: { ...UPGRADE_WIN_STEP4, source: UPGRADE_V3_WORDS.winStep4Source },
  readsRate: true,
  recordsAmount: false,
}

const V4_WORDS: UpgradeVersionWords = {
  ...V3_WORDS,
  checks: (rateBps, amountCents) => {
    const v3 = V3_WORDS.checks(rateBps, undefined)
    const v4 = UPGRADE_V4_WORDS.checks(rateBps, amountCents)
    return { labels: v3.labels, ok: { ...v3.ok, ...v4.ok }, fail: { ...v3.fail, ...v4.fail } }
  },
  step2: UPGRADE_V4_WORDS.step2,
  winStep4: { ...UPGRADE_WIN_STEP4, source: UPGRADE_V4_WORDS.winStep4Source },
  recordsAmount: true,
}

/**
 * The words of each version of the upgrade rules, one entry per version the library checks (a test holds
 * that every rule of `UPGRADE_RULES` has its entry). A version not listed, or an edition with none, gets
 * version 1's words, which name no version but version 1, the one this page checked first.
 */
export const UPGRADE_WORDS_BY_VERSION: Readonly<Record<number, UpgradeVersionWords>> = Object.freeze({
  1: V1_WORDS,
  2: V2_WORDS,
  3: V3_WORDS,
  4: V4_WORDS,
})

export function upgradeWords(engineVersion: number | undefined): UpgradeVersionWords {
  return (engineVersion === undefined ? undefined : UPGRADE_WORDS_BY_VERSION[engineVersion]) ?? V1_WORDS
}
