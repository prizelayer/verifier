import type { CheckName } from "@verifier"

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

/** "What this does not prove", paragraph 2: what the page cannot tell on its own. */
export const NOT_PROVEN_SEEDS =
  "This page reads the fingerprint and the client seed from our server. On its own, it cannot tell whether you saw this fingerprint before your open, or who chose the client seed. The player page shows the fingerprint under the Open button before you press it, and lets you copy it whole under Details. If you kept a copy from before your open, check that it is the fingerprint in step 1. When our server creates a fingerprint for a player, it writes a record in its audit log. This page does not check that record."

/** The pending verdict: what is still locked, when it opens, and what can be checked meanwhile. */
export const LOCKED =
  "The secret for this open is still locked, because it is still being used for your next opens. " +
  'It is revealed when you press "Start a new pair", or, once its pair has served 1,000 opens or is ' +
  "more than 24 hours old, at your next open or your next visit to a box page. " +
  '"Start a new pair" is in the player page, under the Open button, in Details. ' +
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
