#!/usr/bin/env node
// Writes <dist>/SHA256SUMS: one line per built file, "<sha-256>  <path>", sorted by path, in the
// format `shasum -a 256 -c` reads. The publish workflow prints it into the public run log, and both
// hosts serve it next to the page, so a reader can compare a copy with the build that made it.
// Usage: node scripts/sha256sums.mjs dist
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

export const SUMS_FILE = "SHA256SUMS"

/** Every file under `dir`, as a path relative to it with "/" separators, sorted. */
export function filesUnder(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(dir, full).split(sep).join("/"))
    }
  }
  walk(dir)
  return out.filter((p) => p !== SUMS_FILE).sort()
}

export function sumsOf(dir) {
  return filesUnder(dir)
    .map((p) => `${createHash("sha256").update(readFileSync(join(dir, p))).digest("hex")}  ${p}\n`)
    .join("")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = process.argv[2]
  if (!dist) {
    console.error("usage: sha256sums.mjs <dist dir>")
    process.exit(2)
  }
  const text = sumsOf(dist)
  if (text === "") {
    console.error(`sha256sums: ${dist} holds no file`)
    process.exit(1)
  }
  writeFileSync(join(dist, SUMS_FILE), text)
  process.stdout.write(text)
}
