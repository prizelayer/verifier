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
import { demoStepsFor, environments, type Environment } from "./environments"

// Each case starts a shell and node; on a loaded machine that is slower than the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const SCRIPT = join(import.meta.dirname, "check-bundle.sh")
const [DEV, PROD] = environments()
// Each entry is in single quotes, or in double quotes when it holds an apostrophe.
const entries = (loop: string) =>
  [...readFileSync(SCRIPT, "utf8").matchAll(new RegExp(`for ${loop} in ([\\s\\S]*?); do`, "g"))].flatMap((m) =>
    [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((q) => q[1] ?? q[2]),
  )
const REQUIRED = entries("required")
const FORBIDDEN = entries("forbidden")
// The page's sentence about our record of the pair, read from words.ts as text: this project's
// type-check of scripts/ does not resolve the page's imports.
const wordsConstant = (name: string): string => {
  const words = readFileSync(join(import.meta.dirname, "..", "src", "words.ts"), "utf8")
  const literal = new RegExp(`export const ${name}\\b[^=]*=\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(words)?.[1]
  if (literal === undefined) throw new Error(`words.ts has no constant ${name}`)
  return JSON.parse(literal) as string
}
const STEP3_SEED_SET = wordsConstant("STEP3_SEED_SET")

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
    expect(FORBIDDEN).toContain("under the Open button")
  })

  // The sentence about our record of the pair (KAN-935 PR-4): the bundle must keep it as the page says
  // it, and it may not carry a forbidden phrase, such as the old place "under Details".
  it("requires the page's sentence about our record word for word, and it holds no forbidden phrase", () => {
    expect(STEP3_SEED_SET).toMatch(/^Our records say you set this pair's client seed/)
    expect(REQUIRED).toContain(STEP3_SEED_SET)
    for (const phrase of FORBIDDEN) expect(STEP3_SEED_SET.toLowerCase()).not.toContain(phrase.toLowerCase())
    expect(FORBIDDEN).toEqual(expect.arrayContaining(["under Details", "We made both the secret and the client seed"]))
  })

  it.each([
    ["the old place of the fingerprint", "var X='The fingerprint is under Details.'", "under Details"],
    ["the sentence for a client seed nobody set", "var X='We made both the secret and the client seed.'", "We made both the secret and the client seed"],
  ])("fails a page that carries %s", (_name, extra, phrase) => {
    page({ extra })
    const r = check("prod")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`FAIL: the bundle contains: ${phrase}`)
  })

  it("fails a page that lost the step 3 sentence about the client seed", () => {
    page()
    const js = join(dist, "assets", "app-1.js")
    writeFileSync(js, readFileSync(js, "utf8").replace(STEP3_SEED_SET, ""))
    const r = check("prod")
    expect(r.status, r.out).toBe(1)
    expect(r.out).toContain(`FAIL: the script does not contain: ${STEP3_SEED_SET}`)
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

  describe("the dev list of demo steps (demo-steps.json)", () => {
    const DEV_IDS = demoStepsFor("dev")

    it("is the file the build reads, with steps in it, so these cases check something", () => {
      expect(DEV_IDS.length).toBeGreaterThan(0)
      expect(demoStepsFor("prod")).toEqual([])
    })

    it("passes a prod page with no demo id, and says how many it forbade", () => {
      page()
      const r = check("prod")
      expect(r.status, r.out).toBe(0)
      expect(r.out).toContain(`check-bundle: absent: ${DEV_IDS.length} demo step ids of dev's list in demo-steps.json (0 of ${DEV_IDS.length} are prod's own)`)
    })

    it("fails a prod page that carries one id of dev's list", () => {
      const id = DEV_IDS[DEV_IDS.length - 1]
      page({ extra: `var D=new Set(["${id}"]);` })
      const r = check("prod")
      expect(r.status, r.out).toBe(1)
      expect(r.out).toContain(`FAIL: the bundle names demo step ${id} of dev's list (demo-steps.json), which is not prod's`)
    })

    it("passes a dev page that carries dev's own list", () => {
      page({ env: DEV, extra: `var D=new Set(${JSON.stringify(DEV_IDS)});` })
      const r = check("dev")
      expect(r.status, r.out).toBe(0)
      expect(r.out).toContain(`check-bundle: absent: 0 demo step ids of dev's list in demo-steps.json (${DEV_IDS.length} of ${DEV_IDS.length} are dev's own)`)
    })
  })
})
