import type { CheckName } from "@verifier"

/** The four steps, in the words a player reads. Step 1 and step 2 never say when a value was published. */
export const STEPS = [
  {
    step: 1,
    title: "The secret we revealed is the one we registered.",
    method: "SHA-256",
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
    text: [
      "Three things go into the pick: the secret (step 1), a second value called the client seed, and a counter that goes up by one with each open.",
      "Today our server also creates the client seed. You cannot set your own yet.",
      "They are mixed with a standard method. The result is 32 bytes that nobody can predict without the secret.",
      "The first 4 bytes are read as a number. If that number is too large to be shared out evenly, it is thrown away and the next 4 bytes are used. This keeps every result exactly as likely as any other.",
      "The number is then reduced to a value from 0 to 999,999. We call it v.",
    ],
  },
  {
    step: 4,
    title: "From the number to your item.",
    method: null,
    text: [
      "Each prize owns a range of numbers, as wide as its chance. A prize with a 25% chance owns 250,000 of the 1,000,000 numbers.",
      "Your number v falls in exactly one range. That range is a slot. The prize list recorded for your open says which item was in that slot.",
    ],
  },
] as const

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

/** The pending verdict: what is still locked, when it opens, and what can be checked meanwhile. */
export const LOCKED =
  "The secret for this open is still locked, because it is still being used for your next opens. " +
  "It is revealed at your first open after 1,000 opens on this secret, or at your first open more " +
  "than 24 hours after it was created. Until then your browser can check the chances (step 2) and, " +
  "when the proof has one, the prize list, but not the pick itself."

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
