#!/usr/bin/env node
// After a publish: does the mirror's root serve, to a stranger, the "not live yet" page this build
// laid out, and not the dev copy or a redirect?
//
// The subject is the root address a reader types, fetched over HTTPS with compression refused and
// hashed as received; never the file a job uploaded. One line names the address and both hashes.
// A redirect or any other answer than 200 is its status, never "same". Pages may serve the old root
// for a few minutes, so only a DIFFERENT is read again, and only when the Pages publish succeeded.
// When it did not, nothing was published to compare, and the line says so.
//
// Usage: node scripts/prove-root.mjs --page <file> --url <root url ending in /> --pages <job result>
import { readFileSync } from "node:fs"
import { fetchBytes } from "./prove-identical.mjs"
import { sha256 as sha } from "./sha256sums.mjs"

const short = (h) => (/^[0-9a-f]{64}$/.test(h) ? h.slice(0, 12) : h)

/** Compares the root with the page; the verdict and its one line. */
export async function proveRoot({ page, url, pagesResult, fetchFn = fetchBytes, sleep, retryEveryMs = 60_000, retryForMs = 900_000, log = console.log }) {
  if (pagesResult !== "success") {
    log(`RESULT: not checked: the Pages publish did not succeed (publish-pages: ${pagesResult || "no result"}), so nothing new is at ${url}`)
    return true
  }
  const want = sha(readFileSync(page))
  const read = async () => {
    const r = await fetchFn(url)
    return r.state === "OK" ? sha(r.bytes) : r.state === "STATUS" ? `status ${r.status}` : "UNKNOWN"
  }
  let got = await read()
  for (let waited = 0; /^[0-9a-f]{64}$/.test(got) && got !== want && waited < retryForMs; waited += retryEveryMs) {
    log(`${url} still DIFFERENT after ${waited / 1000} s; reading it again in ${retryEveryMs / 1000} s`)
    await sleep(retryEveryMs)
    got = await read()
  }
  const verdict = got === want ? "same" : /^[0-9a-f]{64}$/.test(got) ? "DIFFERENT" : got.toUpperCase()
  log(`${url}  page ${short(want)} · pages ${short(got)}  ${verdict}`)
  log(verdict === "same" ? `RESULT: same: the root serves the not-live page (${page})` : `RESULT: the root does NOT serve the not-live page (${page})`)
  return verdict === "same"
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = {}
  for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1] ?? ""
  if (!a.page || !/^https:\/\/.+\/$/.test(a.url ?? "")) {
    console.error("usage: prove-root.mjs --page <file> --url <https root url ending in /> --pages <job result>")
    process.exit(2)
  }
  const ok = await proveRoot({ page: a.page, url: a.url, pagesResult: a.pages, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
  process.exit(ok ? 0 : 1)
}
