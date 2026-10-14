import axe from "axe-core"
import { expect } from "vitest"

/**
 * axe over a rendered screen. `color-contrast` is off only because jsdom has no layout to measure
 * it; contrast is checked in a real browser.
 */
export async function expectNoAxeViolations(container: HTMLElement) {
  const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } })
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([])
}
