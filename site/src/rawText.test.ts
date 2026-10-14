import { describe, expect, it } from "vitest"
import { MAX_NESTING, rawObjectText, structureProblem } from "./rawText"

describe("rawObjectText", () => {
  it("cuts the object out with its own characters", () => {
    const text = '{"a":1,"snapshot":{"body":{"v": 90071992547409930},"x":2}}'
    expect(rawObjectText(text, ["snapshot", "body"])).toBe('{"v": 90071992547409930}')
  })

  it("takes only a direct member, never a same-named key nested elsewhere", () => {
    const text = '{"edition":{"snapshot":{"body":{"v":1}}},"snapshot":{"body":{"v":2}}}'
    expect(rawObjectText(text, ["snapshot", "body"])).toBe('{"v":2}')
  })

  it("is not fooled by a key name inside a string value", () => {
    const text = '{"note":"\\"snapshot\\":{\\"body\\":{}}","snapshot":{"body":{"v":3}}}'
    expect(rawObjectText(text, ["snapshot", "body"])).toBe('{"v":3}')
  })

  it("reports a missing path as null", () => {
    expect(rawObjectText('{"snapshot":{}}', ["snapshot", "body"])).toBeNull()
    expect(rawObjectText('{"snapshot":{"body":[1]}}', ["snapshot", "body"])).toBeNull()
  })
})

describe("structureProblem", () => {
  const dup = (text: string) => structureProblem(text)

  it("finds a key that appears twice in one object, at any depth", () => {
    expect(dup('{"a":1,"a":2}')).toEqual({ duplicateKey: "a" })
    expect(dup('{"s":{"body":{"v":1},"body":{"v":2}}}')).toEqual({ duplicateKey: "body" })
    expect(dup('{"list":[{"x":1},{"y":2,"y":3}]}')).toEqual({ duplicateKey: "y" })
    expect(dup('{"a\\u0062":1,"ab":2}')).toEqual({ duplicateKey: "ab" })
  })

  it("allows the same key in different objects, a key name inside a string, and a value equal to a key", () => {
    expect(dup('{"a":{"v":1},"b":{"v":2},"note":"\\"a\\":1"}')).toBeNull()
    expect(dup('[{"v":1},{"v":2}]')).toBeNull()
    expect(dup('{"a":"a","b":["a","a"]}')).toBeNull()
  })

  it(`refuses nesting deeper than ${MAX_NESTING}, and reads ${MAX_NESTING} levels`, () => {
    const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth)
    expect(dup(nested(MAX_NESTING))).toBeNull()
    expect(dup(nested(MAX_NESTING + 1))).toEqual({ tooDeep: true })
  })

  it("reads 100,000 levels without exhausting the stack", () => {
    expect(dup(`{"a":${'{"a":'.repeat(100_000)}1${"}".repeat(100_001)}`)).toEqual({ tooDeep: true })
  })
})
