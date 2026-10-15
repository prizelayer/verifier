#!/usr/bin/env node
// After a publish: are the bytes each host serves to a stranger the bytes the build made?
//
// The subject is what a reader would download, so every file is fetched over HTTPS from both hosts,
// with compression refused, and hashed as received. It is never the bytes a job uploaded. Each
// file gets one line that names it and both hashes; a file a host does not serve is MISSING, a host
// that cannot be read is UNKNOWN, and neither is ever reported as the same. A file the page loads
// but the list does not name cannot be compared, so index.html is read for every src and href and
// each must be listed.
//
// Two runs publish nothing and compare nothing, and say which: the switch is off, or the publish
// job never started (its approval was not given, was declined, or ran out). Those exit 0 with their
// own words, never "same".
//
// Usage: node scripts/prove-identical.mjs --dist <dir> --host cloudfront=<url> --host pages=<url>
//          --switch <value> --s3-started <value> [--s3 <job result>] [--pages <job result>]
import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import { join } from "node:path"
import { sha256 as sha, SUMS_FILE } from "./sha256sums.mjs"

const short = (h) => (h.length === 64 ? h.slice(0, 12) : h)

/** Whether this run published anything to compare, and the words when it did not. */
export function gate({ switchValue, s3Started, s3Result = "", pagesResult = "" }) {
  if (switchValue !== "true") return { compare: false, words: "switch off, nothing published, nothing compared" }
  if (s3Started !== "true") {
    return {
      compare: false,
      words: `not published: approval not given, so the publish job never started (publish-s3: ${s3Result || "no result"}, publish-pages: ${pagesResult || "no result"}); nothing compared`,
    }
  }
  return { compare: true, words: "" }
}

/** The list the build wrote: path → sha-256. A line of any other shape makes the list unusable. */
export function parseSums(text) {
  const out = new Map()
  for (const line of text.split("\n")) {
    if (line === "") continue
    const m = /^([0-9a-f]{64}) {2}(\S(?:.*\S)?)$/.exec(line)
    if (!m) throw new Error(`a line of ${SUMS_FILE} is not "<sha-256>  <path>": ${JSON.stringify(line)}`)
    out.set(m[2], m[1])
  }
  if (out.size === 0) throw new Error(`${SUMS_FILE} names no file`)
  return out
}

/** Every relative src and href of index.html, as a path from the page's folder. */
export function pageReferences(html) {
  const refs = []
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) {
    const ref = m[1]
    if (ref === "" || ref.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue
    refs.push(ref.replace(/^\.\//, "").split(/[?#]/)[0])
  }
  return refs
}

/**
 * The answers that mean "this host does not have the file". Our CloudFront host reads a private
 * bucket with no right to list it, and S3 answers 403, not 404, for a missing key to such a reader;
 * nothing rewrites that answer into the page. GitHub Pages answers 404. Any other status is UNKNOWN.
 */
export const MISSING_STATUSES = { cloudfront: [403, 404], pages: [404] }

/** GET one URL with compression refused; the bytes, or the status of any answer that is not 200. */
export function fetchBytes(url, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const get = url.startsWith("https:") ? https.get : http.get
    const req = get(url, { headers: { "accept-encoding": "identity", "cache-control": "no-cache" } }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        const encoding = res.headers["content-encoding"]
        if (res.statusCode !== 200) resolve({ state: "STATUS", status: res.statusCode })
        else if (encoding && encoding !== "identity") resolve({ state: "UNKNOWN", why: `content-encoding ${encoding}` })
        else resolve({ state: "OK", bytes: Buffer.concat(chunks) })
      })
      res.on("error", (e) => resolve({ state: "UNKNOWN", why: e.message }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)))
    req.on("error", (e) => resolve({ state: "UNKNOWN", why: e.message }))
  })
}

async function readHost(name, base, paths, fetchFn) {
  const missing = MISSING_STATUSES[name] ?? [404]
  const out = new Map()
  for (const p of paths) {
    const r = await fetchFn(new URL(p, base).href)
    out.set(p, r.state === "OK" ? sha(r.bytes) : r.state === "STATUS" && missing.includes(r.status) ? "MISSING" : "UNKNOWN")
  }
  return out
}

/**
 * Compares both hosts with the build. `hosts` is [[name, baseUrl], …]; the last host is the GitHub
 * Pages one, whose cache may serve the old bytes for a few minutes, so only a DIFFERENT there is
 * read again, every `retryEveryMs`, for at most `retryForMs`. A MISSING or UNKNOWN is never retried
 * into a pass.
 */
export async function compare({ dist, hosts, fetchFn = fetchBytes, sleep, retryEveryMs = 60_000, retryForMs = 900_000, log = console.log }) {
  const sumsText = readFileSync(join(dist, SUMS_FILE), "utf8")
  const build = parseSums(sumsText)
  build.set(SUMS_FILE, sha(Buffer.from(sumsText)))
  const paths = [...build.keys()]
  let bad = false

  for (const ref of pageReferences(readFileSync(join(dist, "index.html"), "utf8"))) {
    if (!build.has(ref)) {
      log(`NOT LISTED  ${ref}  (index.html loads it, ${SUMS_FILE} does not name it, so it cannot be compared)`)
      bad = true
    }
  }

  const served = new Map()
  for (const [name, base] of hosts) served.set(name, await readHost(name, base, paths, fetchFn))
  const [lastName, lastBase] = hosts[hosts.length - 1]
  const differsOnLast = () => paths.filter((p) => /^[0-9a-f]{64}$/.test(served.get(lastName).get(p)) && served.get(lastName).get(p) !== build.get(p))
  for (let waited = 0; differsOnLast().length > 0 && waited < retryForMs; waited += retryEveryMs) {
    log(`${lastName}: ${differsOnLast().join(", ")} still DIFFERENT after ${waited / 1000} s; reading ${lastName} again in ${retryEveryMs / 1000} s`)
    await sleep(retryEveryMs)
    served.set(lastName, await readHost(lastName, lastBase, paths, fetchFn))
  }

  for (const p of paths) {
    const got = hosts.map(([name]) => [name, served.get(name).get(p)])
    const states = got.map(([, h]) => h)
    const verdict = states.includes("MISSING")
      ? "MISSING"
      : states.includes("UNKNOWN")
        ? "UNKNOWN"
        : states.every((h) => h === build.get(p))
          ? "same"
          : "DIFFERENT"
    if (verdict !== "same") bad = true
    log(`${p}  build ${short(build.get(p))} · ${got.map(([name, h]) => `${name} ${short(h)}`).join(" · ")}  ${verdict}`)
  }
  return !bad
}

function args(argv) {
  const out = { hosts: [] }
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = [argv[i], argv[i + 1] ?? ""]
    if (key === "--host") {
      const at = value.indexOf("=")
      out.hosts.push([value.slice(0, at), value.slice(at + 1)])
    } else out[key.replace(/^--/, "")] = value
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args(process.argv.slice(2))
  const g = gate({ switchValue: a.switch, s3Started: a["s3-started"], s3Result: a.s3, pagesResult: a.pages })
  if (!g.compare) {
    console.log(`RESULT: ${g.words}`)
    process.exit(0)
  }
  if (!a.dist || a.hosts.length !== 2 || a.hosts.some(([n, u]) => !n || !/^https?:\/\/.+\/$/.test(u))) {
    console.error("usage: prove-identical.mjs --dist <dir> --host <name>=<base url ending in /> (twice) --switch true --s3-started true")
    process.exit(2)
  }
  console.log(`publish-s3: ${a.s3 || "?"} · publish-pages: ${a.pages || "?"} · hosts: ${a.hosts.map(([n, u]) => `${n} ${u}`).join(", ")}`)
  let ok
  try {
    ok = await compare({ dist: a.dist, hosts: a.hosts, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
  } catch (e) {
    console.log(`RESULT: UNKNOWN: ${e.message}`)
    process.exit(1)
  }
  console.log(ok ? "RESULT: same: every listed file is the build's bytes on both hosts" : "RESULT: NOT the same on both hosts (see the lines above)")
  process.exit(ok ? 0 : 1)
}
