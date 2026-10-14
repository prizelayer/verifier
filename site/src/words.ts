import type { CheckName } from "@verifier"

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
