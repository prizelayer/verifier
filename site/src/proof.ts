import { parseEdition, parseSnapshotBody, verifyFrom, type VerificationInput, type VerificationReport } from "@verifier"
import { duplicateKey, rawObjectText } from "./rawText"

/** The one format both input paths produce: the public `/verify` answers, unchanged, in one block. */
export const PROOF_FORMAT = "prizelayer-proof/1"

type Json = Record<string, unknown>

/**
 * Turn a pasted proof into the library's input. Anything missing or of the wrong shape throws, and
 * {@link checkProof} reports that as "cannot check" with the message: a page that showed nothing,
 * or a PASS, for a proof it could not read would be worse than no page.
 */
export function proofInput(text: string): VerificationInput {
  const proof = readProof(text)
  if (proof === null) throw new Error(NOT_A_PROOF)
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
    // The body's own text, so a displayed value above 2^53 is read exactly (see rawText.ts).
    input.snapshot = parseSnapshotBody(rawObjectText(text, ["snapshot", "body"]) ?? snapshot.body)
    input.expected.snapshotHash = text_(open.snapshotHash, "open.snapshotHash")
  }
  if (received !== undefined) input.expected.itemId = text_(received.itemId, "received.itemId")
  return input
}

export const NOT_A_PROOF = `This is not a proof we can read. It should start with { "format": "${PROOF_FORMAT}".`

/** The pasted text as a proof object, or `null` when it is not JSON or not this format at all. */
function readProof(text: string): Json | null {
  let proof: unknown
  try {
    proof = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof proof !== "object" || proof === null || (proof as Json).format !== PROOF_FORMAT) return null
  return proof as Json
}

/**
 * What the page shows. `notAProof`: the text is not a proof at all, and no verdict is drawn.
 * Otherwise a report, and the input it was computed from (`null` when the proof could not be read).
 */
export type Checked =
  | { kind: "notAProof"; message: string }
  | { kind: "report"; report: VerificationReport; input: VerificationInput | null }

/** Check a pasted proof. Never throws: an unreadable proof is an `invalid` report with the reason. */
export async function checkProof(text: string): Promise<Checked> {
  if (readProof(text) === null) return { kind: "notAProof", message: NOT_A_PROOF }
  const twice = duplicateKey(text)
  if (twice !== null) return { kind: "notAProof", message: `This is not a valid proof: the key "${twice}" appears twice.` }
  const read: { input: VerificationInput | null } = { input: null }
  const report = await verifyFrom(() => (read.input = proofInput(text)))
  return { kind: "report", report, input: read.input }
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
