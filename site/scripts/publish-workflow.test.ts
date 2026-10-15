import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The shape of the publish workflow, read as text. Each rule here is one reason a publish could
 * happen that nobody approved, or be reported as fine when it was not. The workflow cannot be run
 * from a test, so these lines are what holds it still between reviews.
 */
const WORKFLOW = readFileSync(join(import.meta.dirname, "../../.github/workflows/publish.yml"), "utf8")

/** One job's lines, from its name to the next job. */
function job(name: string): string {
  const jobs = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"))
  const start = jobs.indexOf(`\n  ${name}:\n`)
  expect(start, `job ${name}`).toBeGreaterThan(-1)
  const rest = jobs.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/)
  return next === -1 ? rest : rest.slice(0, next + 1)
}

describe("the publish workflow", () => {
  it("starts on a push to main only: no manual start, no other event", () => {
    expect(WORKFLOW).toContain("\non:\n  push:\n    branches: [main]\n\n")
    for (const event of ["workflow_dispatch", "pull_request", "schedule", "workflow_run", "repository_dispatch", "workflow_call"]) {
      expect(WORKFLOW).not.toContain(event)
    }
  })

  it("runs one publish at a time and never cancels one in progress", () => {
    expect(WORKFLOW).toContain("\nconcurrency:\n  group: verifier-publish\n  cancel-in-progress: false\n")
  })

  it("pins every action by its full commit sha", () => {
    const uses = WORKFLOW.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  })

  it("grants nothing by default, reads no secret, and gives AWS and Pages rights to their own job only", () => {
    expect(WORKFLOW).toContain("\npermissions: {}\n")
    expect(WORKFLOW).not.toContain("secrets.")
    for (const name of ["build", "prove-identical"]) {
      expect(job(name)).not.toContain("id-token")
      expect(job(name)).not.toContain("pages: write")
      expect(job(name)).not.toContain("configure-aws-credentials")
    }
    expect(job("publish-pages")).not.toContain("configure-aws-credentials")
  })

  it("publishes to S3 only behind the switch and inside the environment that needs an approval", () => {
    const s3 = job("publish-s3")
    expect(s3).toContain("    if: vars.VERIFIER_DEPLOYABLE == 'true' && github.ref == 'refs/heads/main'\n")
    expect(s3).toContain("    environment:\n      name: publish\n")
    expect(s3).toContain("      id-token: write\n")
    expect(s3).toContain("configure-aws-credentials@")
  })

  it("publishes to Pages only after the approved S3 job succeeded, so one approval covers both hosts", () => {
    const pages = job("publish-pages")
    expect(pages).toContain("    needs: [build, publish-s3]\n")
    expect(pages).toContain("    if: needs.publish-s3.result == 'success'\n")
  })

  it("marks, as the S3 job's first step, that the job started, and hands it to the check", () => {
    const s3 = job("publish-s3")
    expect(s3).toContain("      started: ${{ steps.started.outputs.started }}\n")
    const firstStep = s3.slice(s3.indexOf("    steps:\n")).split("\n      - ")[1]
    expect(firstStep).toContain('id: started\n        run: echo "started=true" >> "$GITHUB_OUTPUT"')
    const check = job("prove-identical")
    expect(check).toContain("          S3_STARTED: ${{ needs.publish-s3.outputs.started }}\n")
    expect(check).toContain('--s3-started "$S3_STARTED"')
    expect(check).toContain('--switch "$SWITCH"')
  })

  it("stops the S3 job, before any credential, when the environment does not set its five variables", () => {
    const s3 = job("publish-s3")
    const steps = s3.slice(s3.indexOf("    steps:\n")).split("\n      - ")
    const check = steps[2]
    expect(check).toContain("name: Refuse to run without the environment's settings")
    const names = ["VERIFIER_AWS_ACCOUNT_ID", "VERIFIER_AWS_REGION", "VERIFIER_PUBLISH_ROLE", "VERIFIER_BUCKET", "VERIFIER_DISTRIBUTION_ID_PARAMETER"]
    for (const name of names) expect(check).toContain(`          ${name}: \${{ vars.${name} }}\n`)
    expect(check).toContain(`for name in ${names.join(" ")}; do`)
    expect(check).toContain("exit 1")
    expect(s3.indexOf("Refuse to run without")).toBeLessThan(s3.indexOf("configure-aws-credentials"))

    // The step's own script, run as the runner runs it: red with any variable empty, green with all.
    const script = check.slice(check.indexOf("run: |\n") + "run: |\n".length).replace(/^ {10}/gm, "")
    const all = Object.fromEntries(names.map((n) => [n, "x"]))
    const runWith = (env: Record<string, string>) => spawnSync("bash", ["-e", "-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } })
    expect(runWith(all).status).toBe(0)
    for (const name of names) {
      const r = runWith({ ...all, [name]: "" })
      expect(r.status).toBe(1)
      expect(r.stdout).toContain(`does not set: ${name}.`)
    }
  })

  it("checks both hosts whatever the publish jobs did, once the build exists", () => {
    const check = job("prove-identical")
    expect(check).toContain("    needs: [build, publish-s3, publish-pages]\n")
    expect(check).toContain("    if: always() && needs.build.result == 'success'\n")
    expect(check).toContain('--host "cloudfront=$CLOUDFRONT" --host "pages=https://prizelayer.github.io/verifier/"')
  })

  it("names the commit and the run in the build step only, so the tests see a build that names none", () => {
    expect(WORKFLOW.match(/VERIFIER_BUILD_RUN_ID/g)).toHaveLength(1)
    const build = job("build")
    expect(build.indexOf("VERIFIER_BUILD_RUN_ID")).toBeGreaterThan(build.indexOf("npm test"))
    expect(build).toContain("node scripts/sha256sums.mjs dist")
  })
})
