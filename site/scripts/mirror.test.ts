import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
// @ts-expect-error a plain .mjs script, run by node in the workflow
import { proveRoot } from "./prove-root.mjs"
// @ts-expect-error a plain .mjs script, run by node in the workflow
import { sha256 } from "./sha256sums.mjs"

// The GitHub Pages mirror (KAN-956, ADR-KAN-40 amendment of 2026-10-25): production will live at
// its root, so until then the root serves one static page that says so and links to the dev copy,
// which lives under dev/. A page, not a redirect: a redirect would make the dev copy look like the
// product to a reader from outside the company.
const SITE = join(import.meta.dirname, "..")
const ROOT_PAGE = join(SITE, "mirror-root", "index.html")
const ROOT_URL = "https://prizelayer.github.io/verifier/"

describe("the mirror's root page", () => {
  const html = readFileSync(ROOT_PAGE, "utf8")

  it("says that production is not live yet, and links to the dev copy", () => {
    expect(html).toContain("<p>The production verifier is not live yet.</p>")
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["dev/"])
  })

  it("is a page and not a redirect, and loads nothing", () => {
    expect(html.toLowerCase()).not.toContain("refresh")
    expect(html).not.toMatch(/<script|<link|<img|<iframe|src=/i)
    expect(html).toContain(`content="default-src 'none'; base-uri 'none'; form-action 'none'"`)
  })
})

describe("mirror-layout.sh", () => {
  let dir = ""
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kan956-mirror-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const run = (...args: string[]) => {
    const r = spawnSync("sh", [join(SITE, "scripts", "mirror-layout.sh"), ...args], { encoding: "utf8" })
    return { status: r.status, out: r.stdout + r.stderr }
  }
  const files = (d: string): string[] =>
    readdirSync(d, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(d.length + 1))
      .sort()

  it("puts the root page at the root and the dev build, byte for byte, under dev/, and names every file", () => {
    const dev = join(dir, "dev")
    mkdirSync(join(dev, "assets"), { recursive: true })
    writeFileSync(join(dev, "index.html"), "<p>dev page</p>")
    writeFileSync(join(dev, "SHA256SUMS"), "sums")
    writeFileSync(join(dev, "assets", "app-1.js"), "var a")
    const r = run(dev, join(dir, "pages"))
    expect(r.status, r.out).toBe(0)
    expect(files(join(dir, "pages"))).toEqual(["dev/SHA256SUMS", "dev/assets/app-1.js", "dev/index.html", "index.html"])
    expect(readFileSync(join(dir, "pages", "index.html"), "utf8")).toBe(readFileSync(ROOT_PAGE, "utf8"))
    for (const f of files(dev)) expect(readFileSync(join(dir, "pages", "dev", f), "utf8")).toBe(readFileSync(join(dev, f), "utf8"))
    for (const f of ["index.html", "dev/index.html", "dev/SHA256SUMS", "dev/assets/app-1.js"]) expect(r.out).toContain(`\n${f}\n`)
  })

  it("refuses a dev folder with no page or no list, and an out folder that already exists", () => {
    const dev = join(dir, "dev")
    mkdirSync(dev)
    writeFileSync(join(dev, "index.html"), "x")
    expect(run(dev, join(dir, "pages")).out).toContain("has no index.html or no SHA256SUMS. Nothing was laid out.")
    writeFileSync(join(dev, "SHA256SUMS"), "x")
    mkdirSync(join(dir, "pages"))
    const r = run(dev, join(dir, "pages"))
    expect(r.status).toBe(1)
    expect(r.out).toContain("already exists. Nothing was laid out.")
  })
})

describe("build-environment.sh", () => {
  const run = (env: Record<string, string>, cwd = SITE) => {
    const r = spawnSync("sh", [join(SITE, "scripts", "build-environment.sh")], { encoding: "utf8", cwd, env: { PATH: process.env.PATH ?? "", ...env } })
    return { status: r.status, out: r.stdout + r.stderr }
  }

  it("builds nothing when no environment, or no environment name, is given", () => {
    for (const [env, words] of [
      [{}, "VERIFIER_ENV is not set"],
      [{ VERIFIER_ENV: "../prod" }, "'../prod' is not an environment name"],
    ] as const) {
      const r = run(env)
      expect(r.status).toBe(1)
      expect(r.out).toContain(words)
      expect(r.out).toContain("Nothing was built.")
    }
  })

  it("never builds an environment twice in one run, so a second build cannot replace the first", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kan956-build-"))
    try {
      mkdirSync(join(cwd, "out", "dev"), { recursive: true })
      const r = run({ VERIFIER_ENV: "dev" }, cwd)
      expect(r.status).toBe(1)
      expect(r.out).toContain("out/dev already exists: one build per environment per run. Nothing was built.")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe("prove-root.mjs", () => {
  const PAGE = readFileSync(ROOT_PAGE)
  const answers = (...list: object[]) => {
    const asked: string[] = []
    return {
      asked,
      fetchFn: async (url: string) => {
        asked.push(url)
        return list.length > 1 ? list.shift() : list[0]
      },
    }
  }
  const prove = async (pagesResult: string, ...list: object[]) => {
    const lines: string[] = []
    const a = answers(...list)
    const ok = await proveRoot({ page: ROOT_PAGE, url: ROOT_URL, pagesResult, fetchFn: a.fetchFn as never, sleep: async () => {}, retryEveryMs: 1, retryForMs: 3, log: (l: string) => lines.push(l) })
    return { ok, out: lines.join("\n"), asked: a.asked }
  }

  it("passes when the root serves the page's bytes, and names the address and both hashes", async () => {
    const r = await prove("success", { state: "OK", bytes: PAGE })
    expect(r.ok).toBe(true)
    expect(r.asked).toEqual([ROOT_URL])
    expect(r.out).toContain(`${ROOT_URL}  page ${sha256(PAGE).slice(0, 12)} · pages ${sha256(PAGE).slice(0, 12)}  same`)
  })

  it("reads a DIFFERENT root again, as the Pages cache clears, and passes once it serves the page", async () => {
    const r = await prove("success", { state: "OK", bytes: Buffer.from("<p>the old dev page</p>") }, { state: "OK", bytes: PAGE })
    expect(r.ok).toBe(true)
    expect(r.asked).toHaveLength(2)
  })

  it("fails a root that still serves another page once the wait is over", async () => {
    const r = await prove("success", { state: "OK", bytes: Buffer.from("<p>the old dev page</p>") })
    expect(r.ok).toBe(false)
    expect(r.out).toContain("DIFFERENT")
    expect(r.out).toContain("RESULT: the root does NOT serve the not-live page")
  })

  it("fails a redirect and an unreadable root at once, never retried into a pass", async () => {
    for (const [answer, words] of [
      [{ state: "STATUS", status: 301 }, "STATUS 301"],
      [{ state: "UNKNOWN", why: "timeout" }, "UNKNOWN"],
    ] as const) {
      const r = await prove("success", answer, { state: "OK", bytes: PAGE })
      expect(r.ok).toBe(false)
      expect(r.asked).toHaveLength(1)
      expect(r.out).toContain(words)
    }
  })

  it("compares nothing, and says so, when the Pages publish did not succeed", async () => {
    for (const result of ["skipped", "failure", ""]) {
      const r = await prove(result, { state: "OK", bytes: PAGE })
      expect(r.ok).toBe(true)
      expect(r.asked).toEqual([])
      expect(r.out).toContain(`RESULT: not checked: the Pages publish did not succeed (publish-pages: ${result || "no result"})`)
    }
  })
})
