import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { files } from "./sourceFiles"

// The page stores nothing in the browser: a proof is pasted, checked and forgotten. The scan reads
// the source and, in CI after the build (SCAN_DIST=1), the built bundle, because a dependency that
// wrote to storage would not show in src/. Both scans name what they read, so a scan that found
// nothing to read cannot pass as clean.

const ROOT = join(import.meta.dirname, "..")
const SRC = join(ROOT, "src")
const DIST = join(ROOT, "dist")
const APIS = readFileSync(join(import.meta.dirname, "storage-apis.txt"), "utf8").split("\n").filter(Boolean)

function hits(paths: string[], base: string) {
  return paths.flatMap((file) => {
    const text = readFileSync(file, "utf8")
    return APIS.filter((api) => text.includes(api)).map((api) => `${file.slice(base.length + 1)}: ${api}`)
  })
}

describe("no browser storage in the source", () => {
  const sources = files(SRC, /\.(ts|tsx)$/)

  it("reads the files it claims to check, the page and the proof parser among them", () => {
    expect(sources.some((file) => file.endsWith("App.tsx"))).toBe(true)
    expect(sources.some((file) => file.endsWith("proof.ts"))).toBe(true)
  })

  it("looks for all four storage APIs", () => {
    expect([...APIS].sort()).toEqual(["document.cookie", "indexedDB", "localStorage", "sessionStorage"])
  })

  it("finds none of them", () => {
    expect(hits(sources, SRC)).toEqual([])
  })
})

describe.runIf(process.env.SCAN_DIST === "1")("no browser storage in the built bundle", () => {
  it("has a build to read, and finds none of them in its JavaScript", () => {
    expect(existsSync(DIST), `${DIST} does not exist: run npm run build first`).toBe(true)
    const scripts = files(join(DIST, "assets"), /\.js$/)
    expect(scripts.length).toBe(1)
    expect(hits(scripts, DIST)).toEqual([])
  })
})
