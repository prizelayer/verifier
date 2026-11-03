import type { CheckName, UpgradeStepReport, VerificationReport } from "@verifier"
import { FAIL_WORDS, LOCKED, wrongChanceShown, wrongChanceWords, STEP_LOCKED, UPGRADE_FAIL_WORDS, UPGRADE_STEP_OF, UPGRADE_VERDICT, type UpgradeStepName, unusableWords } from "./words"

/** One plain sentence per check: what it means when it matches. Shown only for a check that matched. */
export const CHECK_WORDS: Record<CheckName, string> = {
  commitment: "The secret we revealed matches the fingerprint our server published for this pair.",
  editionFingerprint: "The chances match the fingerprint recorded on your open.",
  drawnPpmValue: "The pick, redone from the secret, the client seed and the counter, gives the number we recorded.",
  drawnSlotIndex: "That number lands on the slot we recorded.",
  snapshotHash: "The prize list is the one recorded on your open.",
  snapshotEditionLink: "The prize list belongs to this box.",
  drawnItemId: "The item in that slot is the item recorded for your win.",
}

/** The fail words of a check; for an upgraded win shown at a wrong chance, the chance's words, not the slot's. */
function slotOrChanceWords(report: VerificationReport, check: CheckName): string {
  const chance = check === "drawnSlotIndex" ? wrongChanceShown(report.checks.drawnSlotIndex) : null
  return chance ? wrongChanceWords(chance) : FAIL_WORDS[check]
}

/** The verdict a reader sees first, in words, never in colour alone. */
export function verdictOf(report: VerificationReport): { word: string; line: string } {
  switch (report.status) {
    case "verified":
      return {
        word: "PASS",
        line: "Your browser recomputed this open from the data above and got the same result we recorded.",
      }
    case "failed": {
      const failure = report.firstFailure
      return {
        word: "FAIL",
        line: !failure
          ? report.summary
          : failure.field !== undefined
            ? `Step ${failure.step} cannot be checked. ${unusableWords(failure.field, failure.message)}`
            : `Step ${failure.step} does not match: ${slotOrChanceWords(report, failure.check)}`,
      }
    }
    case "pending":
      return {
        word: "CANNOT CHECK YET",
        line: LOCKED,
      }
    case "invalid":
      return { word: "CANNOT CHECK", line: report.invalid?.message ?? report.summary }
  }
}

/** The caveat a PASS carries when the item was not compared. A PASS never hides what it left out. */
export function caveatOf(report: VerificationReport): string | null {
  if (report.status !== "verified" || report.notRun.length === 0) return null
  // Read from what the library did not run, so a check it skips in a later version is not missed.
  const skipped = new Set(report.notRun.map((n) => n.check))
  if (skipped.has("snapshotHash")) return "The item was not checked: this proof has no prize list, so the page cannot tell which item was in your slot."
  if (skipped.has("drawnItemId") && skipped.size === 1) return "The item was not checked: this page was not told which item you received."
  return `Not checked: ${report.notRun.map((n) => `${n.check} (${n.reason})`).join("; ")}.`
}

/**
 * The verdict of an upgrade step (KAN-1154). PASS means the check matched, whatever the step's result;
 * the line then says plainly whether it was won or lost, and a lost step is never worded as a win.
 */
export function stepVerdictOf(report: UpgradeStepReport): { word: string; line: string } {
  switch (report.status) {
    case "verified":
      return { word: "PASS", line: report.trace.computedOutcome === "won" ? UPGRADE_VERDICT.won : UPGRADE_VERDICT.lost }
    case "failed": {
      const failure = report.firstFailure
      if (!failure) return { word: "FAIL", line: report.summary }
      const step = UPGRADE_STEP_OF[failure.check as UpgradeStepName]
      return {
        word: "FAIL",
        line:
          failure.field !== undefined
            ? `Step ${step} cannot be checked. ${unusableWords(failure.field, failure.message)}`
            : `Step ${step} does not match: ${UPGRADE_FAIL_WORDS[failure.check as UpgradeStepName]}`,
      }
    }
    case "pending":
      return { word: "CANNOT CHECK YET", line: STEP_LOCKED }
    case "invalid":
      return { word: "CANNOT CHECK", line: report.invalid?.message ?? report.summary }
  }
}
