// Turns the built page into one a browser will run from `file://`.
//
// Vite always writes `<script type="module" crossorigin src=…>`. A module script, and any tag with
// `crossorigin`, is fetched in CORS mode, and a page opened from disk has no origin to grant it, so
// the browser refuses it and the page stays blank. The bundle is an iife (vite.config.ts), so it
// runs the same as a classic script. This rewrites the two tags and fails the build if they are not
// exactly as expected, rather than shipping a page that only works over https.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dist = process.argv[2]
if (!dist) {
  console.error("usage: node scripts/classic-script.mjs <dist dir>")
  process.exit(2)
}
const file = join(dist, "index.html")
let html = readFileSync(file, "utf8")

function once(pattern, replacement, what) {
  const found = html.match(new RegExp(pattern.source, "g")) ?? []
  if (found.length !== 1) {
    console.error(`classic-script: expected exactly one ${what} in ${file}, found ${found.length}`)
    process.exit(1)
  }
  html = html.replace(pattern, replacement)
}

once(/<script type="module" crossorigin src="(\.\/assets\/app-[\w-]+\.js)"><\/script>/, '<script defer src="$1"></script>', "module script")
once(/<link rel="stylesheet" crossorigin href="(\.\/assets\/style-[\w-]+\.css)">/, '<link rel="stylesheet" href="$1">', "stylesheet link")

if (/type="module"|crossorigin/.test(html)) {
  console.error(`classic-script: ${file} still has a module script or a crossorigin attribute`)
  process.exit(1)
}
writeFileSync(file, html)
console.log(`classic-script: ${file} now loads one classic script and one stylesheet`)
