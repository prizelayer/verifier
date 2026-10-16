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

  it("grants nothing by default, and gives each job exactly its own permissions", () => {
    expect(WORKFLOW).toContain("\npermissions: {}\n")
    const exactly: Record<string, string> = {
      build: "    permissions:\n      contents: read\n    defaults:",
      "publish-s3": "    permissions:\n      contents: read\n      id-token: write\n    outputs:",
      "publish-pages": "    permissions:\n      pages: write\n      id-token: write\n    steps:",
      "prove-identical": "    permissions:\n      contents: read\n    steps:",
    }
    for (const [name, block] of Object.entries(exactly)) {
      expect(job(name), name).toContain(block)
      expect(job(name).match(/\n {4}permissions:/g), name).toHaveLength(1)
    }
    for (const name of ["build", "publish-pages", "prove-identical"]) expect(job(name)).not.toContain("configure-aws-credentials")
  })

  it("reads one secret, the account id, in the S3 job only, so the public log never shows it", () => {
    const secrets = WORKFLOW.match(/secrets\.[A-Za-z_]+/g) ?? []
    expect(secrets).toEqual(["secrets.VERIFIER_AWS_ACCOUNT_ID", "secrets.VERIFIER_AWS_ACCOUNT_ID"])
    expect(job("publish-s3").match(/secrets\.VERIFIER_AWS_ACCOUNT_ID/g)).toHaveLength(2)
    expect(WORKFLOW).not.toContain("vars.VERIFIER_AWS_ACCOUNT_ID")
    const s3 = job("publish-s3")
    expect(s3).toContain("          role-to-assume: arn:aws:iam::${{ secrets.VERIFIER_AWS_ACCOUNT_ID }}:role/${{ vars.VERIFIER_PUBLISH_ROLE }}\n")
    expect(s3).toContain("          mask-aws-account-id: true\n")
  })

  it("never leaves the checkout's token on disk", () => {
    const checkouts = WORKFLOW.split("uses: actions/checkout@").slice(1)
    expect(checkouts).toHaveLength(3)
    for (const c of checkouts) expect(c.split("\n      - ")[0]).toContain("persist-credentials: false")
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

  it("runs the guard after the started marker and before any credential or write", () => {
    const s3 = job("publish-s3")
    const steps = s3.slice(s3.indexOf("    steps:\n")).split("\n      - ").slice(1)
    const kinds = steps.map((step) =>
      step.startsWith("id: started")
        ? "started"
        : step.includes("publish-guard.sh\n") && step.includes("run: sh")
          ? "guard"
          : (/^uses: ([\w-]+\/[\w-]+)@/.exec(step)?.[1] ?? (step.includes("publish-s3.sh page") ? "upload" : step.slice(0, 30))),
    )
    expect(kinds).toEqual(["started", "actions/checkout", "guard", "actions/download-artifact", "aws-actions/configure-aws-credentials", "upload"])
    const guard = steps[2]
    expect(guard).toContain("          VERIFIER_AWS_ACCOUNT_ID: ${{ secrets.VERIFIER_AWS_ACCOUNT_ID }}\n")
    for (const name of ["VERIFIER_AWS_REGION", "VERIFIER_PUBLISH_ROLE", "VERIFIER_BUCKET", "VERIFIER_DISTRIBUTION_ID_PARAMETER", "VERIFIER_CLOUDFRONT_HOST"]) {
      expect(guard).toContain(`          ${name}: \${{ vars.${name} }}\n`)
    }
    expect(guard).toContain("run: sh site/scripts/publish-guard.sh")
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
