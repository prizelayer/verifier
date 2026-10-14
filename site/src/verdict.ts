import type { CheckName, VerificationReport } from "@verifier"
import { FAIL_WORDS, LOCKED, unusableWords } from "./words"

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
            : `Step ${failure.step} does not match: ${FAIL_WORDS[failure.check]}`,
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
