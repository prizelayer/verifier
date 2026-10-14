import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPT = join(import.meta.dirname, "classic-script.mjs")
const VITE_HEAD =
  '<script type="module" crossorigin src="./assets/app-AbC_1.js"></script>\n' +
  '<link rel="stylesheet" crossorigin href="./assets/style-XyZ-2.css">\n'

/** Runs the rewrite over one index.html and returns its exit code and the file afterwards. */
function rewrite(html: string) {
  const dist = mkdtempSync(join(tmpdir(), "classic-script-"))
  writeFileSync(join(dist, "index.html"), html)
  const run = spawnSync(process.execPath, [SCRIPT, dist], { encoding: "utf8" })
  return { status: run.status, html: readFileSync(join(dist, "index.html"), "utf8") }
}

describe("classic-script.mjs", () => {
  it("turns Vite's module script and stylesheet into a classic deferred script and a plain link", () => {
    const { status, html } = rewrite(VITE_HEAD)
    expect(status).toBe(0)
    expect(html).toBe('<script defer src="./assets/app-AbC_1.js"></script>\n<link rel="stylesheet" href="./assets/style-XyZ-2.css">\n')
  })

  it("fails, and leaves the file as it was, when the script tag is not the one shape it knows", () => {
    const changed = VITE_HEAD.replace("crossorigin src", "src")
    const { status, html } = rewrite(changed)
    expect(status).toBe(1)
    expect(html).toBe(changed)
  })

  it("fails when a second module script would stay behind", () => {
    const { status } = rewrite(`${VITE_HEAD}<script type="module" src="./other.js"></script>\n`)
    expect(status).toBe(1)
  })
})
