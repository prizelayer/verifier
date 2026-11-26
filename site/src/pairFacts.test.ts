import { describe, expect, it } from "vitest"
import { EXAMPLE_PROOF } from "./example"
import { seedSetFact, seedSetSentence } from "./pairFacts"
import { PAIR_RECORD } from "./test/fakeServer"
import { STEP3_SEED_SET } from "./words"

// Every row of the rule in pairFacts.ts: what the two fields read as together. A value the page cannot
// read for sure is "unknown", never the side that says more.
// Refs: KAN-935

const HASH = PAIR_RECORD.setEventRecordHash
const proof = (seedPair: Record<string, unknown>) => JSON.stringify({ ...EXAMPLE_PROOF, seedPair: { ...EXAMPLE_PROOF.seedPair, ...seedPair } })

describe("clientSeedSetByPlayer with setEventRecordHash", () => {
  it.each([
    ["true with a 64-hex hash", "yes", true, HASH],
    ["false with null", "no", false, null],
    ["true with null (the flag alone)", "unknown", true, null],
    ["false with a hash (the hash alone)", "unknown", false, HASH],
    ["true with an uppercase hash", "unknown", true, HASH.toUpperCase()],
    ["true with a short hash", "unknown", true, HASH.slice(0, 63)],
    ["true with a longer hash", "unknown", true, `${HASH}0`],
    ["the string true with a hash", "unknown", "true", HASH],
    ["null with null", "unknown", null, null],
    ["the hash in an array", "unknown", true, [HASH]],
  ])("%s reads as %s", (_name, fact, flag, hash) => {
    expect(seedSetFact(proof({ clientSeedSetByPlayer: flag, setEventRecordHash: hash }))).toBe(fact)
  })

  it.each([
    ["the flag without the hash key", { clientSeedSetByPlayer: true }],
    ["the hash without the flag key", { setEventRecordHash: HASH }],
    ["false without the hash key", { clientSeedSetByPlayer: false }],
  ])("%s reads as unknown", (_name, seedPair) => {
    expect(seedSetFact(proof(seedPair))).toBe("unknown")
  })

  it("absent, as in a proof saved before the fields existed, reads as unknown", () => {
    expect(seedSetFact(JSON.stringify(EXAMPLE_PROOF))).toBe("unknown")
  })
})

describe("a text that is not a proof", () => {
  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no seedPair", JSON.stringify({ ...EXAMPLE_PROOF, seedPair: undefined })],
    ["a seedPair that is an array", JSON.stringify({ ...EXAMPLE_PROOF, seedPair: [PAIR_RECORD] })],
  ])("%s reads as unknown", (_name, text) => {
    expect(seedSetFact(text)).toBe("unknown")
  })
})

describe("the sentence", () => {
  it.each([
    ["yes, from the lookup", "yes", true, STEP3_SEED_SET],
    ["yes, pasted or edited", "yes", false, null],
    ["no, from the lookup", "no", true, null],
    ["unknown, from the lookup", "unknown", true, null],
  ] as const)("%s", (_name, fact, fromLookup, sentence) => {
    expect(seedSetSentence(fact, fromLookup)).toBe(sentence)
  })
})
