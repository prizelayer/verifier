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
 * `sums` is where that environment's footer links the list of the published files. Dev's still
 * points at the mirror's root until its copy moves to `/verifier/dev/` (the owner's decision on
 * KAN-956: the move and this value change together).
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
