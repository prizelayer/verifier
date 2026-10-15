import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPT = join(import.meta.dirname, "publish-guard.sh")
const SHA = "57d5f4c5a1b2c3d4e5f60718293a4b5c6d7e8f90"
const OTHER = "1111111111111111111111111111111111111111"
const SETTINGS = {
  VERIFIER_AWS_ACCOUNT_ID: "123456789012",
  VERIFIER_AWS_REGION: "eu-central-1",
  VERIFIER_PUBLISH_ROLE: "example-site-publish",
  VERIFIER_BUCKET: "example-site",
  VERIFIER_DISTRIBUTION_ID_PARAMETER: "/example/site/distribution-id",
  VERIFIER_CLOUDFRONT_HOST: "d111111abcdef8.cloudfront.net",
  GITHUB_SHA: SHA,
  GITHUB_REPOSITORY: "example/verifier",
}

/** Runs the guard with a stand-in `git` whose ls-remote answers `head` (or fails when null). */
function guard(env: Record<string, string>, head: string | null = SHA) {
  const bin = mkdtempSync(join(tmpdir(), "bin-"))
  writeFileSync(join(bin, "git"), head === null ? "#!/bin/sh\nexit 128\n" : `#!/bin/sh\nprintf '%s\\trefs/heads/main\\n' ${head}\n`)
  chmodSync(join(bin, "git"), 0o755)
  const run = spawnSync("sh", [SCRIPT], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } })
  return { status: run.status, out: run.stdout + run.stderr }
}

describe("publish-guard.sh", () => {
  it("passes with every setting and this commit at the head of main, and masks the account id and the role", () => {
    const r = guard(SETTINGS)
    expect(r.status).toBe(0)
    expect(r.out).toContain("::add-mask::123456789012\n")
    expect(r.out).toContain("::add-mask::arn:aws:iam::123456789012:role/example-site-publish\n")
    expect(r.out).toContain(`${SHA} is the head of main`)
  })

  it("stops, naming the setting and never its value, when any one is missing", () => {
    for (const name of Object.keys(SETTINGS)) {
      const r = guard({ ...SETTINGS, [name]: "" })
      expect(r.status, name).toBe(1)
      expect(r.out).toContain(`does not set: ${name}. Nothing was published.`)
      expect(r.out).not.toContain("::add-mask::")
    }
  })

  it("stops when a setting has the wrong shape, and prints no value", () => {
    const wrong: Record<string, string> = {
      VERIFIER_AWS_ACCOUNT_ID: "12345678901",
      VERIFIER_AWS_REGION: "Frankfurt",
      VERIFIER_PUBLISH_ROLE: "bad role!",
      VERIFIER_BUCKET: "Example_Site",
      VERIFIER_DISTRIBUTION_ID_PARAMETER: "distribution-id",
      VERIFIER_CLOUDFRONT_HOST: "https://d111111abcdef8.cloudfront.net/",
    }
    for (const [name, value] of Object.entries(wrong)) {
      const r = guard({ ...SETTINGS, [name]: value })
      expect(r.status, name).toBe(1)
      expect(r.out).toContain(`::error::${name} does not have the shape of`)
      // The runner swallows "::add-mask::" lines: they never reach the log. Every other line is read.
      const shown = r.out.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n")
      expect(shown).not.toContain(value)
    }
  })

  it("refuses to publish an older build over a newer one: this commit must still be the head of main", () => {
    const r = guard(SETTINGS, OTHER)
    expect(r.status).toBe(1)
    expect(r.out).toContain(`this run builds ${SHA}, but main is now ${OTHER}`)
  })

  it("stops when the head of main cannot be read, rather than assume it", () => {
    const r = guard(SETTINGS, null)
    expect(r.status).toBe(1)
    expect(r.out).toContain("the head of main could not be read")
  })
})
