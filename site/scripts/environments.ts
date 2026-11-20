import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "vite"

/**
 * One build of the page per environment (ADR-KAN-29 point 6 and ADR-KAN-40, amendments of
 * 2026-10-25). Each environment's page asks only that environment's public API, and its own policy
 * names only that API, so a production page can never read a dev open and show it as proven.
 * The values live in `environments.json`, one copy that the build, the bundle check and the
 * offline test all read.
 *
 * `sums` is where that environment's footer links the list of the published files: dev's copy is
 * under the mirror's `/verifier/dev/`, and production will be at the mirror's root.
 */
export type Environment = { name: string; api: string; sums: string }

const FILE = join(import.meta.dirname, "..", "environments.json")
const NAME = /^[a-z]+$/
// A bare https origin: no path, no port, no user, lower case.
const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/
const SUMS = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?\/([a-z0-9-]+\/)*SHA256SUMS$/

/** Every environment in the table, checked: a value of the wrong shape stops whoever reads it. */
export function environments(text: string = readFileSync(FILE, "utf8")): Environment[] {
  const table = JSON.parse(text) as Record<string, { api?: unknown; sums?: unknown }>
  const list = Object.entries(table).map(([name, value]) => {
    const api = value?.api
    const sums = value?.sums
    if (!NAME.test(name)) throw new Error(`environments.json: '${name}' is not an environment name`)
    if (typeof api !== "string" || !ORIGIN.test(api)) throw new Error(`environments.json: ${name}.api must be a bare https origin, not '${String(api)}'`)
    if (typeof sums !== "string" || !SUMS.test(sums)) throw new Error(`environments.json: ${name}.sums must be an https address ending in /SHA256SUMS, not '${String(sums)}'`)
    return { name, api, sums }
  })
  if (list.length === 0) throw new Error("environments.json names no environment")
  if (new Set(list.map((e) => e.api)).size !== list.length) throw new Error("environments.json: two environments share one API")
  return list
}

/**
 * The environment a build is for. A build (`vite build`) must name it in `VERIFIER_ENV`: there is
 * no default, so a production build can never come out as dev by accident. The dev server and the
 * tests use dev when nothing is named.
 */
export function environmentFor(env: Record<string, string | undefined>, isBuild: boolean, list: Environment[] = environments()): Environment {
  const name = env.VERIFIER_ENV ?? ""
  if (name === "") {
    if (isBuild) throw new Error(`VERIFIER_ENV is not set: name the environment this build is for (${list.map((e) => e.name).join(" or ")}).`)
    return mustFind(list, "dev")
  }
  return mustFind(list, name)
}

function mustFind(list: Environment[], name: string): Environment {
  const found = list.find((e) => e.name === name)
  if (found === undefined) throw new Error(`VERIFIER_ENV '${name}' is not in environments.json (${list.map((e) => e.name).join(", ")})`)
  return found
}

/** The one place in index.html where the environment's API goes: its policy's connect-src. */
export const API_TOKEN = "%VERIFIER_API%"

/**
 * Writes the environment's API into the page's own policy. The token must be in index.html exactly
 * once and must not survive, so a page can never ship with no API, or with a second one.
 */
export function policyFor(environment: Environment): Plugin {
  return {
    name: "verifier-policy",
    transformIndexHtml(html) {
      const count = html.split(API_TOKEN).length - 1
      if (count !== 1) throw new Error(`index.html holds ${API_TOKEN} ${count} times, not once`)
      return html.replace(API_TOKEN, environment.api)
    },
  }
}

/**
 * The dev list of the upgrade steps drawn at 93 % on 17 and 18 November 2026 (KAN-1751 plan v1.2 D3 A): a step
 * on it is checked under the library's `DEMO_RULES_2026_11_17`, every other step under its version's
 * rule. Only dev may have a list; production has none, and a file that gives any other environment one
 * stops the build. The list names the read that made it, and a list with steps but no read is refused.
 * Its `date` is the day the demo rule started, 17 November, as in the rule set's name; the steps run into
 * 18 November. It is deleted at dev's next reset.
 * Refs: KAN-1751, KAN-1685
 */
const DEMO_FILE = join(import.meta.dirname, "..", "demo-steps.json")
const STEP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function demoStepsFor(environment: string, text: string = readFileSync(DEMO_FILE, "utf8")): string[] {
  const table = JSON.parse(text) as Record<string, { date?: unknown; read?: unknown; stepIds?: unknown }>
  for (const name of Object.keys(table)) {
    if (name !== "dev") throw new Error(`demo-steps.json: only dev has a list of demo steps, not '${name}'`)
  }
  const dev = table.dev
  if (dev === undefined) return []
  if (dev.date !== "2026-11-17") throw new Error(`demo-steps.json: the list is of the demo rule that started on 2026-11-17, not '${String(dev.date)}'`)
  const ids = dev.stepIds
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !STEP_ID.test(id))) {
    throw new Error("demo-steps.json: dev.stepIds must be a list of step ids in lower case")
  }
  if (new Set(ids).size !== ids.length) throw new Error("demo-steps.json: a step id is listed twice")
  if (ids.length > 0 && (typeof dev.read !== "string" || dev.read === "")) {
    throw new Error("demo-steps.json: a list with steps names the read that made it in dev.read")
  }
  return environment === "dev" ? (ids as string[]) : []
}
