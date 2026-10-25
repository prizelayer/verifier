import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
// @ts-expect-error a plain .mjs script, run by node in the workflow
import { compare, gate, pageReferences, parseSums } from "./prove-identical.mjs"
// @ts-expect-error a plain .mjs script, run by node in the workflow
import { sumsOf } from "./sha256sums.mjs"

const SCRIPT = join(import.meta.dirname, "prove-identical.mjs")
const INDEX = '<!doctype html><script defer src="./assets/app-1.js"></script><link rel="stylesheet" href="./assets/style-1.css"><a href="https://github.com/prizelayer/verifier">code</a><a href="#top">top</a>'

/** A built page: index.html, a script, a stylesheet and the SHA256SUMS the build writes. */
function builtDist(index = INDEX) {
  const dist = mkdtempSync(join(tmpdir(), "prove-identical-"))
  mkdirSync(join(dist, "assets"))
  writeFileSync(join(dist, "index.html"), index)
  writeFileSync(join(dist, "assets/app-1.js"), "console.log(1)\n")
  writeFileSync(join(dist, "assets/style-1.css"), "body{}\n")
  writeFileSync(join(dist, "SHA256SUMS"), sumsOf(dist))
  return dist
}

/** A copy of `dist` that a host serves, changed by `edit`. */
function hostCopy(dist: string, edit: (dir: string) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "host-"))
  cpSync(dist, dir, { recursive: true })
  edit(dir)
  return dir
}

const servers: http.Server[] = []
afterEach(() => servers.splice(0).forEach((s) => s.close()))

/**
 * Serves `dir` under `prefix`; `missing` is the status for a file it does not have (404, or 403 as
 * S3 answers a reader that cannot list the bucket). `headers` are added to every answer. `rootPage`,
 * when given, is answered at the prefix itself instead of index.html. A path that leaves `dir`
 * answers `missing`: the test server must not read files outside its folder.
 */
async function serve(dir: string, prefix = "/", headers: Record<string, string> = {}, missing = 404, rootPage?: string) {
  const root = resolve(dir)
  const server = http.createServer((req, res) => {
    try {
      const path = decodeURIComponent((req.url ?? "").slice(prefix.length))
      if (!path && rootPage !== undefined) return void res.writeHead(200, headers).end(rootPage)
      const file = resolve(root, path || "index.html")
      if (!file.startsWith(root + sep)) return void res.writeHead(missing).end("not found")
      const body = readFileSync(file)
      res.writeHead(200, headers).end(body)
    } catch {
      res.writeHead(missing).end("not found")
    }
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`
}

async function run(dist: string, cloudfront: string, pages: string, sleeps: number[] = []) {
  const lines: string[] = []
  const ok = await compare({
    dist,
    hosts: [["cloudfront", cloudfront], ["pages", pages]],
    sleep: async (ms: number) => void sleeps.push(ms),
    retryEveryMs: 60_000,
    retryForMs: 180_000,
    log: (l: string) => lines.push(l),
  })
  return { ok, lines, verdict: (path: string) => lines.find((l) => l.startsWith(`${path}  `))?.split("  ").pop() }
}

describe("the test host itself", () => {
  it("answers 404 for a path that leaves its folder, plain or encoded, and never reads the file", async () => {
    const dir = hostCopy(builtDist())
    const outside = join(dir, "..", `outside-${process.pid}-${Date.now()}`)
    writeFileSync(outside, "secret")
    const name = outside.split(sep).pop()
    const base = await serve(dir)
    const get = (path: string) =>
      new Promise<number>((done, fail) => http.get(base.replace(/\/$/, "") + path, (res) => done(res.resume().statusCode ?? 0)).on("error", fail))
    expect(readFileSync(outside, "utf8")).toBe("secret")
    expect(await get("/index.html")).toBe(200)
    expect(await get(`/../${name}`)).toBe(404)
    expect(await get(`/%2e%2e%2f${name}`)).toBe(404)
    rmSync(outside)
  })
})

describe("prove-identical: the bytes each host serves, compared with the build", () => {
  it("says same, file by file and by name, when both hosts serve the build's bytes", async () => {
    const dist = builtDist()
    const r = await run(dist, await serve(hostCopy(dist)), await serve(hostCopy(dist), "/verifier/"))
    expect(r.ok).toBe(true)
    for (const p of ["/", "SHA256SUMS", "assets/app-1.js", "assets/style-1.css", "index.html"]) expect(r.verdict(p)).toBe("same")
  })

  it("says DIFFERENT for the one file a host serves with one byte changed", async () => {
    const dist = builtDist()
    const changed = hostCopy(dist, (d) => writeFileSync(join(d, "assets/app-1.js"), "console.log(2)\n"))
    const r = await run(dist, await serve(changed), await serve(hostCopy(dist)))
    expect(r.ok).toBe(false)
    expect(r.verdict("assets/app-1.js")).toBe("DIFFERENT")
    expect(r.verdict("index.html")).toBe("same")
  })

  it("says MISSING for a file Pages still does not serve once the wait is over", async () => {
    const dist = builtDist()
    const sleeps: number[] = []
    const pages = hostCopy(dist, (d) => rmSync(join(d, "assets/style-1.css")))
    const r = await run(dist, await serve(hostCopy(dist)), await serve(pages), sleeps)
    expect(r.ok).toBe(false)
    expect(r.verdict("assets/style-1.css")).toBe("MISSING")
    expect(sleeps).toEqual([60_000, 60_000, 60_000])
  })

  it("reads a MISSING on Pages again, as a path new to it appears, and passes once it serves the bytes", async () => {
    const dist = builtDist()
    const pages = hostCopy(dist, (d) => rmSync(join(d, "assets/style-1.css")))
    const lines: string[] = []
    const ok = await compare({
      dist,
      hosts: [["cloudfront", await serve(hostCopy(dist))], ["pages", await serve(pages)]],
      sleep: async () => cpSync(join(dist, "assets/style-1.css"), join(pages, "assets/style-1.css")),
      retryEveryMs: 60_000,
      retryForMs: 180_000,
      log: (l: string) => lines.push(l),
    })
    expect(ok, lines.join("\n")).toBe(true)
    expect(lines).toContain("pages: assets/style-1.css still DIFFERENT or MISSING after 0 s; reading pages again in 60 s")
  })

  it("never reads a MISSING on the CloudFront host again: only the Pages cache can lag", async () => {
    const dist = builtDist()
    const sleeps: number[] = []
    const cloudfront = hostCopy(dist, (d) => rmSync(join(d, "assets/style-1.css")))
    const r = await run(dist, await serve(cloudfront), await serve(hostCopy(dist)), sleeps)
    expect(r.ok).toBe(false)
    expect(r.verdict("assets/style-1.css")).toBe("MISSING")
    expect(sleeps).toEqual([])
  })

  it("reads a 403 from the CloudFront host as MISSING, because S3 answers 403 for a missing key there", async () => {
    const dist = builtDist()
    const cloudfront = hostCopy(dist, (d) => rmSync(join(d, "assets/app-1.js")))
    const r = await run(dist, await serve(cloudfront, "/", {}, 403), await serve(hostCopy(dist)))
    expect(r.ok).toBe(false)
    expect(r.verdict("assets/app-1.js")).toBe("MISSING")
    expect(r.lines.find((l) => l.startsWith("assets/app-1.js  "))).toContain("cloudfront MISSING")
  })

  it("reads a 403 from the Pages host as UNKNOWN: Pages answers 404 for a missing file", async () => {
    const dist = builtDist()
    const pages = hostCopy(dist, (d) => rmSync(join(d, "assets/app-1.js")))
    const sleeps: number[] = []
    const r = await run(dist, await serve(hostCopy(dist)), await serve(pages, "/", {}, 403), sleeps)
    expect(r.ok).toBe(false)
    expect(r.verdict("assets/app-1.js")).toBe("UNKNOWN")
    expect(sleeps).toEqual([])
  })

  it("says UNKNOWN, never same, when a host cannot be reached", async () => {
    const dist = builtDist()
    const r = await run(dist, await serve(hostCopy(dist)), "http://127.0.0.1:9/")
    expect(r.ok).toBe(false)
    expect(r.verdict("index.html")).toBe("UNKNOWN")
  })

  it("says UNKNOWN when a host compresses the answer it was asked to send plain", async () => {
    const dist = builtDist()
    const r = await run(dist, await serve(hostCopy(dist), "/", { "content-encoding": "gzip" }), await serve(hostCopy(dist)))
    expect(r.ok).toBe(false)
    expect(r.verdict("index.html")).toBe("UNKNOWN")
  })

  it("reports a half publish: the new build on one host, the old one on Pages, after a bounded wait", async () => {
    const dist = builtDist()
    const old = hostCopy(dist, (d) => writeFileSync(join(d, "index.html"), INDEX.replace("code", "old")))
    const sleeps: number[] = []
    const r = await run(dist, await serve(hostCopy(dist)), await serve(old), sleeps)
    expect(r.ok).toBe(false)
    expect(r.verdict("index.html")).toBe("DIFFERENT")
    expect(sleeps).toEqual([60_000, 60_000, 60_000])
    expect(r.lines.filter((l) => l.includes("still DIFFERENT"))).toHaveLength(3)
  })

  it("does not wait for Pages when the Pages publish did not succeed: waiting cannot bring it", async () => {
    const dist = builtDist()
    const old = hostCopy(dist, (d) => writeFileSync(join(d, "index.html"), INDEX.replace("code", "old")))
    const sleeps: number[] = []
    const lines: string[] = []
    const ok = await compare({
      dist,
      hosts: [["cloudfront", await serve(hostCopy(dist))], ["pages", await serve(old)]],
      sleep: async (ms: number) => void sleeps.push(ms),
      retryLast: false,
      log: (l: string) => lines.push(l),
    })
    expect(ok).toBe(false)
    expect(sleeps).toEqual([])
    expect(lines.find((l) => l.startsWith("index.html  "))?.endsWith("DIFFERENT")).toBe(true)
  })

  it("reads the page's own address too: a host that serves an old page at / is DIFFERENT there", async () => {
    const dist = builtDist()
    const base = await serve(hostCopy(dist), "/", {}, 404, INDEX.replace("code", "old"))
    const r = await run(dist, base, await serve(hostCopy(dist), "/verifier/"))
    expect(r.ok).toBe(false)
    expect(r.verdict("/")).toBe("DIFFERENT")
    expect(r.verdict("index.html")).toBe("same")
  })

  it("passes once the Pages cache serves the new bytes within the wait", async () => {
    const dist = builtDist()
    const pages = hostCopy(dist, (d) => writeFileSync(join(d, "index.html"), INDEX.replace("code", "old")))
    let reads = 0
    const lines: string[] = []
    const ok = await compare({
      dist,
      hosts: [["cloudfront", await serve(hostCopy(dist))], ["pages", await serve(pages)]],
      sleep: async () => {
        reads += 1
        writeFileSync(join(pages, "index.html"), INDEX)
      },
      retryEveryMs: 60_000,
      retryForMs: 900_000,
      log: (l: string) => lines.push(l),
    })
    expect(ok).toBe(true)
    expect(reads).toBe(1)
  })

  it("fails when index.html loads a file the list does not name, because it cannot be compared", async () => {
    const dist = builtDist(INDEX.replace("</script>", '</script><img src="./assets/extra.png">'))
    const r = await run(dist, await serve(hostCopy(dist)), await serve(hostCopy(dist)))
    expect(r.ok).toBe(false)
    expect(r.lines.some((l) => l.startsWith("NOT LISTED  assets/extra.png"))).toBe(true)
  })
})

describe("prove-identical: the runs that publish nothing say so, and never say same", () => {
  it("names the switch when it is off", () => {
    expect(gate({ switchValue: "", s3Started: "" })).toEqual({ compare: false, words: "switch off, nothing published, nothing compared" })
    expect(gate({ switchValue: "false", s3Started: "" }).compare).toBe(false)
  })

  it("names the approval when the publish job never started (declined, expired or not yet given)", () => {
    for (const s3Result of ["skipped", "cancelled", "failure"]) {
      const g = gate({ switchValue: "true", s3Started: "", s3Result, pagesResult: "skipped" })
      expect(g.compare).toBe(false)
      expect(g.words).toMatch(/^not published: approval not given/)
      expect(g.words).toContain(`publish-s3: ${s3Result}`)
      expect(g.words).not.toMatch(/same|DIFFERENT|MISSING/)
    }
  })

  it("compares once the publish job has started, whatever its result", () => {
    expect(gate({ switchValue: "true", s3Started: "true", s3Result: "failure" }).compare).toBe(true)
  })

  it("compares a publish that started even when the switch was turned off during it", () => {
    // An emergency stop while a job runs must not make the record say that nothing was published.
    expect(gate({ switchValue: "false", s3Started: "true", s3Result: "success" })).toEqual({ compare: true, words: "" })
    expect(gate({ switchValue: "", s3Started: "true", s3Result: "cancelled" }).compare).toBe(true)
  })

  it("from the command line: exit 0 and the named words, with nothing fetched", () => {
    const off = spawnSync(process.execPath, [SCRIPT, "--switch", "", "--s3-started", ""], { encoding: "utf8" })
    expect([off.status, off.stdout.trim()]).toEqual([0, "RESULT: switch off, nothing published, nothing compared"])
    const declined = spawnSync(process.execPath, [SCRIPT, "--switch", "true", "--s3-started", "", "--s3", "failure", "--pages", "skipped"], { encoding: "utf8" })
    expect(declined.status).toBe(0)
    expect(declined.stdout).toMatch(/^RESULT: not published: approval not given/)
  })
})

describe("the list and the page's references", () => {
  it("reads the list the build wrote, and refuses a line of another shape or an empty list", () => {
    const dist = builtDist()
    expect([...parseSums(readFileSync(join(dist, "SHA256SUMS"), "utf8")).keys()]).toEqual(["assets/app-1.js", "assets/style-1.css", "index.html"])
    expect(() => parseSums("abc  index.html\n")).toThrow(/not "<sha-256>  <path>"/)
    expect(() => parseSums("")).toThrow(/names no file/)
  })

  it("takes every relative src and href of index.html, and no link to another site or to a fragment", () => {
    expect(pageReferences(INDEX)).toEqual(["assets/app-1.js", "assets/style-1.css"])
  })
})
