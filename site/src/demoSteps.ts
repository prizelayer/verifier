import { DEMO_RULES_2026_11_17, type UpgradeStepOptions } from "@verifier"

declare const __VERIFIER_DEMO_STEPS__: readonly string[]

/**
 * The steps this build checks under the demo rules of 17 and 18 November 2026: dev's list (`demo-steps.json`),
 * and none in a production build (scripts/environments.ts, demoStepsFor).
 * Refs: KAN-1751, KAN-1685
 */
export const DEMO_STEP_IDS: ReadonlySet<string> = new Set(__VERIFIER_DEMO_STEPS__)

/** The options of one step's check: the demo rules for a listed step id, none for any other. */
export function stepOptions(stepId: unknown, listed: ReadonlySet<string> = DEMO_STEP_IDS): UpgradeStepOptions {
  return typeof stepId === "string" && listed.has(stepId.toLowerCase()) ? { demoRules: DEMO_RULES_2026_11_17 } : {}
}
