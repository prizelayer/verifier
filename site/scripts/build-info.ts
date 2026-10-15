/**
 * Which build made this copy, read from the environment of the build. The publish workflow sets
 * `VERIFIER_BUILD_COMMIT` and `VERIFIER_BUILD_RUN_ID`; any other build sets neither, and the page
 * then says it names no build. A value of the wrong shape is treated as absent rather than shown,
 * so the footer never links to a commit or a run that cannot exist.
 */
export type BuildInfo = { commit: string; runId: string }

export function buildInfoFrom(env: Record<string, string | undefined>): BuildInfo | null {
  const commit = env.VERIFIER_BUILD_COMMIT ?? ""
  const runId = env.VERIFIER_BUILD_RUN_ID ?? ""
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^[1-9][0-9]{0,19}$/.test(runId)) return null
  return { commit, runId }
}
