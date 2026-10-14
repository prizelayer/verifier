import { describe, expect, it } from "vitest"
import { duplicateKey, rawObjectText } from "./rawText"

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

describe("duplicateKey", () => {
  it("finds a key that appears twice in one object, at any depth", () => {
    expect(duplicateKey('{"a":1,"a":2}')).toBe("a")
    expect(duplicateKey('{"s":{"body":{"v":1},"body":{"v":2}}}')).toBe("body")
    expect(duplicateKey('{"list":[{"x":1},{"y":2,"y":3}]}')).toBe("y")
  })

  it("allows the same key in different objects, and a key name inside a string", () => {
    expect(duplicateKey('{"a":{"v":1},"b":{"v":2},"note":"\\"a\\":1"}')).toBeNull()
    expect(duplicateKey('[{"v":1},{"v":2}]')).toBeNull()
  })
})
