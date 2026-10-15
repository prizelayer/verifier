import type { BuildInfo } from "../scripts/build-info"

declare const __VERIFIER_BUILD__: BuildInfo | null

/** The build that made this copy, fixed at build time; null when it was not the publish workflow. */
export const BUILD: BuildInfo | null = __VERIFIER_BUILD__
