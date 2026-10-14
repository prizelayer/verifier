import { describe, expect, it } from "vitest"
import { rawObjectText } from "./rawText"

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
