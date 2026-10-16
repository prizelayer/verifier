import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPT = join(import.meta.dirname, "publish-s3.sh")
const COMMIT = "57d5f4c5a1b2c3d4e5f60718293a4b5c6d7e8f90"

/**
 * Runs the script with a stand-in `aws` first on PATH, which records every call and answers the two
 * reads. No AWS is reached: the test proves the order of the calls and what each one names.
 */
function publish(env: Record<string, string>, files = ["index.html", "SHA256SUMS"], failOn?: string) {
  const dist = mkdtempSync(join(tmpdir(), "dist-"))
  for (const f of files) writeFileSync(join(dist, f), f)
  const bin = mkdtempSync(join(tmpdir(), "bin-"))
  const log = join(bin, "calls")
  writeFileSync(
    join(bin, "aws"),
    `#!/bin/sh\necho "$*" >> "${log}"\n` +
      (failOn ? `case "$*" in *"${failOn}"*) exit 1;; esac\n` : "") +
      `case "$1 $2" in "ssm get-parameter") echo E1234567890;; "cloudfront create-invalidation") echo I42;; esac\n`,
  )
  chmodSync(join(bin, "aws"), 0o755)
  const run = spawnSync("sh", [SCRIPT, dist], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } })
  let calls: string[] = []
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").map((l) => l.replaceAll(dist, "<dist>"))
  } catch {
    calls = []
  }
  return { status: run.status, out: run.stdout + run.stderr, calls }
}

const ENV = { BUCKET: "site-bucket", DISTRIBUTION_ID_PARAMETER: "/x/distribution-id", COMMIT }

describe("publish-s3.sh", () => {
  it("writes the record copy, the loaded files, SHA256SUMS and index.html last, then cleans and invalidates", () => {
    const r = publish(ENV)
    expect(r.status).toBe(0)
    expect(r.calls).toEqual([
      `s3 cp <dist> s3://site-bucket/releases/${COMMIT}/ --recursive --only-show-errors`,
      "s3 cp <dist> s3://site-bucket/ --recursive --exclude index.html --exclude SHA256SUMS --cache-control public, max-age=31536000, immutable --only-show-errors",
      "s3 cp <dist>/SHA256SUMS s3://site-bucket/SHA256SUMS --cache-control no-cache --content-type text/plain; charset=utf-8 --only-show-errors",
      "s3 cp <dist>/index.html s3://site-bucket/index.html --cache-control no-cache --content-type text/html; charset=utf-8 --only-show-errors",
      "s3 sync <dist> s3://site-bucket/ --delete --exclude releases/* --exclude index.html --exclude SHA256SUMS --cache-control public, max-age=31536000, immutable --only-show-errors",
      "ssm get-parameter --name /x/distribution-id --query Parameter.Value --output text",
      "cloudfront create-invalidation --distribution-id E1234567890 --paths /* --query Invalidation.Id --output text",
      "cloudfront wait invalidation-completed --distribution-id E1234567890 --id I42",
    ])
  })

  it("stops before index.html when the loaded files cannot be written, so the old page stays whole", () => {
    const r = publish(ENV, undefined, "--exclude index.html --exclude SHA256SUMS --cache-control")
    expect(r.status).not.toBe(0)
    expect(r.calls.some((c) => c.includes("s3://site-bucket/index.html"))).toBe(false)
    expect(r.calls.some((c) => c.startsWith("s3 sync"))).toBe(false)
  })

  it("refuses to start without its settings, a full commit sha, or a build with SHA256SUMS", () => {
    for (const missing of ["BUCKET", "DISTRIBUTION_ID_PARAMETER", "COMMIT"]) {
      const env: Record<string, string> = { ...ENV }
      delete env[missing]
      const r = publish(env)
      expect(r.status).not.toBe(0)
      expect(r.calls).toEqual([])
    }
    expect(publish({ ...ENV, COMMIT: COMMIT.slice(0, 12) }).calls).toEqual([])
    expect(publish(ENV, ["index.html"]).calls).toEqual([])
  })
})
