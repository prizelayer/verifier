import { CHECK_NAMES, STEP_OF, type CheckName, type VerificationReport } from "@verifier"
import { describe, expect, it } from "vitest"
import { CHECK_WORDS, verdictOf } from "./verdict"
import { FAIL_WORDS, LOCKED } from "./words"

function report(status: VerificationReport["status"], failed?: CheckName): VerificationReport {
  const r: VerificationReport = { ok: status === "verified", status, notRun: [], checks: {}, trace: {}, caveats: [], summary: "summary" }
  if (failed) r.firstFailure = { check: failed, step: STEP_OF[failed], message: "expected a, computed b" }
  if (status === "invalid") r.invalid = { message: "commitmentHex is missing or has the wrong type" }
  return r
}

// One row per result the library can give, and a FAIL at every check of every step: the word and
// the line come from `status` and `firstFailure` only, and a FAIL never quotes the words of a match.
describe("verdictOf", () => {
  it("a failure on an input that cannot be used names the input and claims no comparison", () => {
    const r = report("failed", "commitment")
    r.firstFailure = { check: "commitment", step: 1, field: "commitmentHex", message: "the commitment must be 64 hex characters" }
    const { word, line } = verdictOf(r)
    expect(word).toBe("FAIL")
    expect(line).toBe(
      "Step 1 cannot be checked. The value seedPair.serverSeedCommitment cannot be used: the commitment must be 64 hex characters.",
    )
    expect(line).not.toContain(FAIL_WORDS.commitment)
  })

  it("verified is PASS", () => {
    expect(verdictOf(report("verified")).word).toBe("PASS")
  })

  it("pending is CANNOT CHECK YET, with the words of the locked secret", () => {
    expect(verdictOf(report("pending"))).toEqual({ word: "CANNOT CHECK YET", line: LOCKED })
  })

  it("invalid is CANNOT CHECK, with the library's plain reason", () => {
    expect(verdictOf(report("invalid"))).toEqual({ word: "CANNOT CHECK", line: "commitmentHex is missing or has the wrong type" })
  })

  it.each(CHECK_NAMES.map((name) => [STEP_OF[name], name] as const))("a failure at step %i (%s) is FAIL, in its own words", (step, name) => {
    const { word, line } = verdictOf(report("failed", name))
    expect(word).toBe("FAIL")
    expect(line).toBe(`Step ${step} does not match: ${FAIL_WORDS[name]}`)
    expect(line).not.toContain(CHECK_WORDS[name])
  })
})
