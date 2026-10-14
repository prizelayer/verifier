import { describe, expect, it } from "vitest"
import { EXAMPLE_TEXT } from "./example"
import { layOut, layOutParts } from "./layOut"

describe("layOut", () => {
  it("only adds whitespace: without the added pieces the text is the proof's exact text", () => {
    const text = JSON.stringify(JSON.parse(EXAMPLE_TEXT))
    const parts = layOutParts(text)
    expect(parts).not.toBeNull()
    expect(parts!.filter((part) => !part.added).map((part) => part.text).join("")).toBe(text)
    expect(parts!.filter((part) => part.added).every((part) => /^\s+$/.test(part.text))).toBe(true)
    expect(layOut(text).split("\n").length).toBeGreaterThan(20)
  })

  it("keeps a number above 2^53 and the braces, commas and escapes inside strings as they are", () => {
    const text = '{"a":[12345678901234567890,{}],"b":"x,{\\"y\\":[1]}","c":[]}'
    expect(layOut(text)).toBe(
      '{\n  "a": [\n    12345678901234567890,\n    {}\n  ],\n  "b": "x,{\\"y\\":[1]}",\n  "c": []\n}',
    )
  })

  it("gives back a text that already has whitespace outside its strings unchanged", () => {
    expect(layOut('{ "a": 1 }')).toBe('{ "a": 1 }')
    expect(layOut('{"a":"b c"}')).toBe('{\n  "a": "b c"\n}')
  })
})
