import { describe, expect, it } from "vitest"
import { buildInfoFrom } from "./build-info"

const COMMIT = "57d5f4c5a1b2c3d4e5f60718293a4b5c6d7e8f90"

describe("buildInfoFrom", () => {
  it("reads the commit and the run of the publish workflow", () => {
    expect(buildInfoFrom({ VERIFIER_BUILD_COMMIT: COMMIT, VERIFIER_BUILD_RUN_ID: "18012345678" })).toEqual({
      commit: COMMIT,
      runId: "18012345678",
    })
  })

  it("names no build when either value is missing", () => {
    expect(buildInfoFrom({})).toBeNull()
    expect(buildInfoFrom({ VERIFIER_BUILD_COMMIT: COMMIT })).toBeNull()
    expect(buildInfoFrom({ VERIFIER_BUILD_RUN_ID: "1" })).toBeNull()
  })

  it("names no build when a value has the wrong shape, so no link points at nothing", () => {
    expect(buildInfoFrom({ VERIFIER_BUILD_COMMIT: COMMIT.slice(0, 12), VERIFIER_BUILD_RUN_ID: "1" })).toBeNull()
    expect(buildInfoFrom({ VERIFIER_BUILD_COMMIT: COMMIT.toUpperCase(), VERIFIER_BUILD_RUN_ID: "1" })).toBeNull()
    expect(buildInfoFrom({ VERIFIER_BUILD_COMMIT: COMMIT, VERIFIER_BUILD_RUN_ID: "12/../x" })).toBeNull()
    expect(buildInfoFrom({ VERIFIER_BUILD_COMMIT: COMMIT, VERIFIER_BUILD_RUN_ID: "0" })).toBeNull()
  })
})
