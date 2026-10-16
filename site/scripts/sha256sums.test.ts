import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPT = join(import.meta.dirname, "sha256sums.mjs")
const hex = (s: string) => createHash("sha256").update(s).digest("hex")

describe("sha256sums.mjs", () => {
  it("writes one sorted line per built file, in shasum's format, and prints the same list", () => {
    const dist = mkdtempSync(join(tmpdir(), "sums-"))
    mkdirSync(join(dist, "assets"))
    writeFileSync(join(dist, "index.html"), "page")
    writeFileSync(join(dist, "assets/app.js"), "js")
    writeFileSync(join(dist, "SHA256SUMS"), "an old list, which is not listed")
    const run = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" })
    const expected = `${hex("js")}  assets/app.js\n${hex("page")}  index.html\n`
    expect(run.status).toBe(0)
    expect(readFileSync(join(dist, "SHA256SUMS"), "utf8")).toBe(expected)
    expect(run.stdout).toBe(expected)
  })

  it("fails on an empty build rather than write an empty list", () => {
    const run = spawnSync(process.execPath, [SCRIPT, mkdtempSync(join(tmpdir(), "sums-"))], { encoding: "utf8" })
    expect(run.status).toBe(1)
  })
})
