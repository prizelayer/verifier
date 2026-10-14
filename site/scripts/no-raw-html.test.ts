import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { files } from "./sourceFiles"

// Everything the page shows from a proof or a fetched answer is rendered by React as text. The scan
// names every source file it read, and fails on any way to write HTML from a string.
const SRC = join(import.meta.dirname, "..", "src")
const SINKS = [
  "dangerouslySetInnerHTML",
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "document.write",
  "createContextualFragment",
  "DOMParser",
  "setHTML",
  "parseHTMLUnsafe",
  "srcdoc",
  "srcDoc",
]

describe("no raw HTML in the source", () => {
  it("writes HTML from a string nowhere", () => {
    const read = files(SRC, /\.[cm]?[jt]sx?$/)
    console.log(`no-raw-html: read ${read.map((file) => file.slice(SRC.length + 1)).join(", ")}`)
    expect(read).toContain(join(SRC, "LookupBox.tsx"))
    const hits = read.flatMap((file) => {
      const text = readFileSync(file, "utf8")
      return SINKS.filter((sink) => text.includes(sink)).map((sink) => `${file.slice(SRC.length + 1)}: ${sink}`)
    })
    expect(hits).toEqual([])
  })
})
