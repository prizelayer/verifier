import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** Every file under `dir` whose name matches `pattern`, test files left out. */
export function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path, pattern)
    return pattern.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
