// The first step of each browser job, which runs in Playwright's own image (KAN-1162). The image holds
// the OS packages and the browsers of exactly one Playwright version, so nothing is installed in the
// job. This check fails loudly before any test when that version is not the one the job's lockfile
// installs: a Playwright bump that forgets the image tag stops here, it never runs other browsers.
//
// Usage: node .github/scripts/check-playwright-image.mjs <job id in ci.yml> <path to package-lock.json>
// Run from the directory whose node_modules holds that lockfile's Playwright.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const [job, lockfile] = process.argv.slice(2)
if (!job || !lockfile) fail("usage: check-playwright-image.mjs <job> <package-lock.json>")

// The image tag this job runs in, read from the workflow itself so there is one place to write it.
const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "ci.yml"), "utf8")
const block = workflow.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).find((part) => part.startsWith(`${job}:`))
if (!block) fail(`no job "${job}" in ci.yml`)
const image = block.match(/image: mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}\s*$/m)
if (!image) fail(`job "${job}" does not run in mcr.microsoft.com/playwright:v<version>-noble pinned by digest`)

// The Playwright the lockfile installs. playwright-core is the package that owns the browser builds.
const packages = JSON.parse(readFileSync(lockfile, "utf8")).packages ?? {}
const locked = packages["node_modules/playwright-core"]?.version
if (!locked) fail(`${lockfile} installs no playwright-core`)
if (image[1] !== locked) {
  fail(`job "${job}" runs in the Playwright ${image[1]} image, but ${lockfile} installs Playwright ${locked}: move the image tag and its digest`)
}

// And the browsers that Playwright will look for are really in the image.
const plan = execFileSync("npx", ["playwright", "install", "--dry-run", "chromium", "firefox", "webkit"], { encoding: "utf8" })
const locations = [...plan.matchAll(/^\s*Install location:\s+(\S+)\s*$/gm)].map((m) => m[1])
if (locations.length === 0) fail("playwright install --dry-run named no install location")
const missing = locations.filter((path) => !existsSync(path))
if (missing.length > 0) fail(`the image lacks the browsers Playwright ${locked} needs: ${missing.join(", ")}`)

console.log(`job "${job}": image Playwright ${image[1]} = ${lockfile} Playwright ${locked}; ${locations.length} browser builds present`)

function fail(message) {
  console.error(`::error::${message}`)
  process.exit(1)
}
