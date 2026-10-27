import {
  parseEdition,
  parseSnapshotBody,
  UPGRADE_STEP_CHECK_NAMES,
  verifyFrom,
  verifyUpgradeStep,
  type UpgradeStepInput,
  type UpgradeStepReport,
  type VerificationInput,
  type VerificationReport,
} from "@verifier"
import { rawObjectText, structureProblem } from "./rawText"

/** The one format both input paths produce: the public `/verify` answers, unchanged, in one block. */
export const PROOF_FORMAT = "prizelayer-proof/1"

/**
 * The format of an upgrade step's proof (KAN-1154): its own string, so a step proof is never read as
 * an open proof, and `prizelayer-proof/1` keeps the meaning it was published with.
 */
export const STEP_PROOF_FORMAT = "prizelayer-step-proof/1"

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
  // A win made by an upgrade is read over the step's two ranges, never over the box (KAN-1154).
  if (open.gameKind === "upgrade") {
    input.gameKind = "upgrade"
    input.expected.upgradeStepId = text_(open.upgradeStepId, "open.upgradeStepId")
    input.expected.stakedSlotIndex = number_(open.stakedSlotIndex, "open.stakedSlotIndex")
    input.expected.stepChancePpm = number_(open.stepChancePpm, "open.stepChancePpm")
    input.expected.stepOutcome = outcome_(open.stepOutcome, "open.stepOutcome")
  }
  return input
}

/** Turn a pasted step proof into the library's step input. Anything missing throws, as {@link proofInput}. */
export function stepProofInput(text: string): UpgradeStepInput {
  const proof = readProof(text)
  if (proof === null || proof.format !== STEP_PROOF_FORMAT) throw new Error(NOT_A_PROOF)
  const step = section(proof, "step")
  const seedPair = section(proof, "seedPair")
  const edition = section(proof, "edition")
  const revealed = seedPair.revealedServerSeed
  return {
    serverSeedHex: revealed === null ? null : text_(revealed, "seedPair.revealedServerSeed"),
    commitmentHex: text_(seedPair.serverSeedCommitment, "seedPair.serverSeedCommitment"),
    clientSeed: text_(seedPair.clientSeed, "seedPair.clientSeed"),
    nonce: number_(step.nonce, "step.nonce"),
    edition: parseEdition(edition),
    engineType: text_(step.engineType, "step.engineType"),
    expected: {
      editionFingerprint: text_(step.editionFingerprint, "step.editionFingerprint"),
      stakedSlotIndex: number_(step.stakedSlotIndex, "step.stakedSlotIndex"),
      targetSlotIndex: number_(step.targetSlotIndex, "step.targetSlotIndex"),
      chancePpm: number_(step.chancePpm, "step.chancePpm"),
      drawnPpmValue: number_(step.drawnPpmValue, "step.drawnPpmValue"),
      outcome: outcome_(step.outcome, "step.outcome"),
      stepNo: number_(step.stepNo, "step.stepNo"),
    },
  }
}

export const NOT_A_PROOF =
  `This is not a proof we can read. It should start with { "format": "${PROOF_FORMAT}" (an open) ` +
  `or { "format": "${STEP_PROOF_FORMAT}" (an upgrade).`

/** The pasted text as a proof object, or `null` when it is not JSON or not this format at all. */
function readProof(text: string): Json | null {
  let proof: unknown
  try {
    proof = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof proof !== "object" || proof === null) return null
  const format = (proof as Json).format
  if (format !== PROOF_FORMAT && format !== STEP_PROOF_FORMAT) return null
  return proof as Json
}

/**
 * What the page shows. `notAProof`: the text is not a proof at all, and no verdict is drawn.
 * Otherwise a report, and the input it was computed from (`null` when the proof could not be read).
 */
export type Checked =
  | { kind: "notAProof"; message: string }
  | { kind: "report"; report: VerificationReport; input: VerificationInput | null }
  | { kind: "stepReport"; report: UpgradeStepReport; input: UpgradeStepInput | null }

/**
 * The proof of a lookup, joined from the answers' own TEXT, never parsed and written again: the
 * prize list carries displayed values as bare JSON numbers, and rewriting them would round any
 * value above 2^53. The layout is the one {@link proofInput} reads.
 */
export function joinProof(answers: {
  open: string
  seedPair: string
  edition: string
  snapshot: string | null
  itemId: string | null
}): string {
  const parts = [
    `"format":${JSON.stringify(PROOF_FORMAT)}`,
    `"open":${answers.open}`,
    `"seedPair":${answers.seedPair}`,
    `"edition":${answers.edition}`,
    ...(answers.snapshot === null ? [] : [`"snapshot":${answers.snapshot}`]),
    ...(answers.itemId === null ? [] : [`"received":${JSON.stringify({ itemId: answers.itemId })}`]),
  ]
  return `{${parts.join(",")}}`
}

/**
 * The proof of an upgrade step, joined from the answers' own text like {@link joinProof}. The layout
 * is the one {@link stepProofInput} reads.
 */
export function joinStepProof(answers: { step: string; seedPair: string; edition: string }): string {
  return `{${[
    `"format":${JSON.stringify(STEP_PROOF_FORMAT)}`,
    `"step":${answers.step}`,
    `"seedPair":${answers.seedPair}`,
    `"edition":${answers.edition}`,
  ].join(",")}}`
}

/** Check a pasted proof. Never throws: an unreadable proof is an `invalid` report with the reason. */
export async function checkProof(text: string): Promise<Checked> {
  const proof = readProof(text)
  if (proof === null) return { kind: "notAProof", message: NOT_A_PROOF }
  const problem = structureProblem(text)
  if (problem !== null) {
    const message =
      "tooDeep" in problem
        ? "This is not a valid proof: it is nested too deeply."
        : `This is not a valid proof: the key "${problem.duplicateKey}" appears twice.`
    return { kind: "notAProof", message }
  }
  if (proof.format === STEP_PROOF_FORMAT) {
    let input: UpgradeStepInput
    try {
      input = stepProofInput(text)
    } catch (error) {
      // The library's own refusal shape: a step proof that cannot be read is CANNOT CHECK, never a verdict.
      const message = error instanceof Error ? error.message : String(error)
      return { kind: "stepReport", report: unreadableStep(message), input: null }
    }
    return { kind: "stepReport", report: await verifyUpgradeStep(input), input }
  }
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

/** A step proof that could not be read: CANNOT CHECK with the reason, every check not run, as the library reports it. */
function unreadableStep(message: string): UpgradeStepReport {
  return {
    ok: false,
    status: "invalid",
    invalid: { message },
    notRun: UPGRADE_STEP_CHECK_NAMES.map((check) => ({ check, reason: "the proof could not be read" })),
    checks: {},
    trace: {},
    caveats: [],
    summary: `CANNOT CHECK: ${message}`,
  }
}

function outcome_(value: unknown, field: string): "won" | "lost" {
  if (value !== "won" && value !== "lost") throw new Error(`The proof has no ${field}.`)
  return value
}

function number_(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`The proof has no ${field}.`)
  return value
}
