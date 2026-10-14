import { parseEdition, parseSnapshotBody, verifyFrom, type VerificationInput, type VerificationReport } from "@verifier"

/** The one format both input paths produce: the public `/verify` answers, unchanged, in one block. */
export const PROOF_FORMAT = "prizelayer-proof/1"

type Json = Record<string, unknown>

/**
 * Turn a pasted proof into the library's input. Anything missing or of the wrong shape throws, and
 * {@link checkProof} reports that as "cannot check" with the message: a page that showed nothing,
 * or a PASS, for a proof it could not read would be worse than no page.
 */
export function proofInput(text: string): VerificationInput {
  let proof: unknown
  try {
    proof = JSON.parse(text)
  } catch {
    proof = undefined
  }
  if (typeof proof !== "object" || proof === null || (proof as Json).format !== PROOF_FORMAT) {
    throw new Error(`This is not a proof we can read. It should start with { "format": "${PROOF_FORMAT}".`)
  }
  const open = section(proof as Json, "open")
  const seedPair = section(proof as Json, "seedPair")
  const edition = section(proof as Json, "edition")
  const snapshot = (proof as Json).snapshot === undefined ? undefined : section(proof as Json, "snapshot")
  const received = (proof as Json).received === undefined ? undefined : section(proof as Json, "received")

  const revealed = seedPair.revealedServerSeed
  const input: VerificationInput = {
    serverSeedHex: revealed === null ? null : text_(revealed, "seedPair.revealedServerSeed"),
    commitmentHex: text_(seedPair.serverSeedCommitment, "seedPair.serverSeedCommitment"),
    clientSeed: text_(seedPair.clientSeed, "seedPair.clientSeed"),
    nonce: number_(open.nonce, "open.nonce"),
    edition: parseEdition(edition),
    expected: {
      editionFingerprint: text_(open.editionFingerprint, "open.editionFingerprint"),
      drawnPpmValue: number_(open.drawnPpmValue, "open.drawnPpmValue"),
      drawnSlotIndex: number_(open.drawnSlotIndex, "open.drawnSlotIndex"),
    },
  }
  if (snapshot !== undefined) {
    input.snapshot = parseSnapshotBody(snapshot.body)
    input.expected.snapshotHash = text_(open.snapshotHash, "open.snapshotHash")
  }
  if (received !== undefined) input.expected.itemId = text_(received.itemId, "received.itemId")
  return input
}

/** Check a pasted proof. Never throws: an unreadable proof is an `invalid` report with the reason. */
export function checkProof(text: string): Promise<VerificationReport> {
  return verifyFrom(() => proofInput(text))
}

function section(proof: Json, name: string): Json {
  const value = proof[name]
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The proof has no "${name}" section.`)
  }
  return value as Json
}

function text_(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`The proof has no ${field}.`)
  return value
}

function number_(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`The proof has no ${field}.`)
  return value
}
