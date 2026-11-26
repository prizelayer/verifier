import { STEP3_SEED_SET } from "./words"

/**
 * What our server's record says about who set this open's client seed, read from the proof's own text:
 * `seedPair.clientSeedSetByPlayer` with `seedPair.setEventRecordHash`. The page cannot check this fact:
 * it is our claim, so every value the page cannot read for sure counts as "unknown", and unknown shows
 * the words the page had before, which say less. Yes only for `true` with 64 lowercase hex characters,
 * no only for `false` with `null`; every other pair, an absent field and a text that is not a proof:
 * unknown.
 *
 * Step 1 gets no sentence of this kind and keeps its words: the approved one named a place the player
 * page no longer has, so the step 1 sentence stays as it was (a decision of 2026-11-26).
 * Refs: KAN-935
 */
export type Fact = "yes" | "no" | "unknown"

const RECORD_HASH = /^[0-9a-f]{64}$/

type Json = Record<string, unknown>
const objectIn = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null

export function seedSetFact(text: string): Fact {
  let proof: unknown
  try {
    proof = JSON.parse(text)
  } catch {
    return "unknown"
  }
  const seedPair = objectIn(objectIn(proof)?.seedPair)
  if (seedPair === null) return "unknown"
  const byPlayer = seedPair.clientSeedSetByPlayer
  const hash = seedPair.setEventRecordHash
  if (byPlayer === true && typeof hash === "string" && RECORD_HASH.test(hash)) return "yes"
  if (byPlayer === false && hash === null) return "no"
  return "unknown"
}

/**
 * Step 3's sentence about this pair, or `null` where step 3 keeps its words. It needs a proof that
 * "Look up" fetched in this visit and that nobody edited since (`fromLookup`): a pasted proof can say
 * anything about our records.
 */
export function seedSetSentence(fact: Fact, fromLookup: boolean): string | null {
  return fromLookup && fact === "yes" ? STEP3_SEED_SET : null
}
