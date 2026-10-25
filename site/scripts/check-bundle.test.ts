// Tests for scripts/check-bundle.sh's environment rules (KAN-956): a page built for one
// environment names that environment's API as its policy's one host and in its script, and no
// other environment's API anywhere. The fixtures are built pages written as text, with every
// other rule of the check satisfied, so a FAIL here can only come from the rule under test. The
// required words are read from the script itself, so the fixture cannot drift from it.
// Refs: KAN-956
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { environments, type Environment } from "./environments"

// Each case starts a shell and node; on a loaded machine that is slower than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const SCRIPT = join(import.meta.dirname, "check-bundle.sh")
const [DEV, PROD] = environments()
const REQUIRED = [...readFileSync(SCRIPT, "utf8").matchAll(/for required in ([\s\S]*?); do/g)]
  .flatMap((m) => [...m[1].matchAll(/'([^']*)'/g)].map((q) => q[1]))

let dist: string

/** A built page for `env`, which passes every rule; `policy` and `extra` vary what is under test. */
function page({ env = PROD, policy, extra = "" }: { env?: Environment; policy?: string; extra?: string } = {}) {
  policy ??= `connect-src ${env.api}`
  mkdirSync(join(dist, "assets"), { recursive: true })
  writeFileSync(
    join(dist, "index.html"),
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; ${policy}; base-uri 'none'">` +
      `<script defer src="./assets/app-1.js"></script><link rel="stylesheet" href="./assets/style-1.css">`,
  )
  writeFileSync(join(dist, "assets", "app-1.js"), `var A=\`${env.api}\`,S=\`${env.sums}\`;${JSON.stringify(REQUIRED)};${extra}`)
  writeFileSync(join(dist, "assets", "style-1.css"), ".a{color:red}")
}

function check(env: string | undefined) {
  const vars: Record<string, string> = { PATH: process.env.PATH ?? "" }
  if (env !== undefined) vars.VERIFIER_ENV = env
  const res = spawnSync("sh", [SCRIPT, dist], { encoding: "utf8", env: vars })
  return { status: res.status, out: res.stdout + res.stderr }
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "kan956-bundle-"))
})
afterEach(() => rmSync(dist, { recursive: true, force: true }))

describe("check-bundle.sh, per environment", () => {
  it("reads at least the page's words from the script, so the fixture checks something", () => {
    expect(REQUIRED).toContain("Check an open yourself")
    expect(REQUIRED.length).toBeGreaterThan(5)
  })

  it("passes a prod page that names only prod's API, and says what it forbade", () => {
    page()
    const r = check("prod")
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain(`check-bundle: environment prod: API ${PROD.api}, list ${PROD.sums}`)
    expect(r.out).toContain(`check-bundle: absent: ${DEV.api} (the API of dev)`)
  })

  it("fails a prod page whose policy also lists the dev API", () => {
    page({ policy: `connect-src ${PROD.api} ${DEV.api}` })
    const r = check("prod")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`carries 'connect-src ${PROD.api} ${DEV.api}', not 'connect-src ${PROD.api}'`)
    expect(r.out).toContain(`FAIL: the bundle names ${DEV.api}, the API of dev`)
  })

  it("fails a prod page whose script names the dev host without its scheme", () => {
    page({ extra: `var H="https://"+\`${DEV.api.replace("https://", "")}\`` })
    const r = check("prod")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`FAIL: the bundle names ${DEV.api.replace("https://", "")}, the host of dev's API`)
  })

  it("fails a dev page whose script names the prod host without its scheme", () => {
    page({ env: DEV, extra: `var H=\`${PROD.api.replace("https://", "")}\`` })
    const r = check("dev")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`FAIL: the bundle names ${PROD.api.replace("https://", "")}, the host of prod's API`)
  })

  it("fails a prod page whose script still names the dev API", () => {
    page({ extra: `var D=\`${DEV.api}\`` })
    const r = check("prod")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`FAIL: the bundle names ${DEV.api}, the API of dev`)
  })

  it("fails a dev page checked as prod", () => {
    page({ env: DEV })
    const r = check("prod")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`not 'connect-src ${PROD.api}'`)
    expect(r.out).toContain(`FAIL: the script does not name its environment's API ${PROD.api}`)
  })

  it("passes the dev page as dev", () => {
    page({ env: DEV })
    const r = check("dev")
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain(`check-bundle: absent: ${PROD.api} (the API of prod)`)
  })

  it("fails a page that does not link its environment's list", () => {
    page()
    writeFileSync(join(dist, "assets", "app-1.js"), `var A=\`${PROD.api}\`;${JSON.stringify(REQUIRED)}`)
    const r = check("prod")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`FAIL: the script does not link its environment's list ${PROD.sums}`)
  })

  it.each([
    ["unset", undefined, "VERIFIER_ENV is not set"],
    ["not in the table", "staging", "VERIFIER_ENV 'staging' is not in"],
  ])("checks nothing and fails when VERIFIER_ENV is %s", (_name, env, message) => {
    page()
    const r = check(env)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(message)
    expect(r.out).toContain("Nothing was checked.")
  })
})
