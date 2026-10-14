import { joinProof } from "./proof"
import { structureProblem } from "./rawText"

/**
 * The one server this page may ask anything, and only when the reader presses "Look up". The
 * page's Content-Security-Policy names the same host, and the bundle check allows no other.
 */
export const API_BASE = "https://public-api.dev.prizelayer.com"

/**
 * The largest answer the page reads, per request. A real answer is a few kilobytes; the cap stops
 * a broken or hostile answer from filling the reader's memory before anything is checked.
 */
export const MAX_ANSWER_BYTES = 1_000_000

/** How long a whole lookup may take. A server that never answers must not leave the page waiting. */
export const LOOKUP_TIMEOUT_MS = 15_000

/** What a lookup gives the page: the proof as text, or a named reason why there is none. */
export type LookupResult =
  | { kind: "found"; text: string }
  | { kind: "notAnId" }
  | { kind: "notFound" }
  | { kind: "unreachable" }
  | { kind: "timedOut" }
  | { kind: "serverFault"; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A fault in our server's answer, as opposed to a network that did not answer at all. */
class ServerFault extends Error {}

/** The network did not answer: offline, blocked, or refused by the browser. */
class Unreachable extends Error {}

/** Our server took longer than {@link LOOKUP_TIMEOUT_MS}. */
class TimedOut extends Error {}

const HASH = /^[0-9a-f]{64}$/

/** How a reader sees the fields a fault names: in words, not as the API spells them. */
const LABEL: Record<string, string> = {
  winId: "win id",
  seedPairId: "seed pair id",
  editionId: "box id",
  snapshotHash: "prize list fingerprint",
}

/**
 * Fetches the four public answers for one open and joins them, unchanged, into one proof.
 *
 * Every request is a plain GET with no credentials and no custom header, so the browser sends no
 * cookie and no preflight request.
 */
export async function lookUp(
  winId: string,
  itemId: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<LookupResult> {
  const id = winId.trim()
  if (!UUID.test(id)) return { kind: "notAnId" }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), LOOKUP_TIMEOUT_MS)
  const get = (path: string) => answer(fetchFn, path, abort.signal)
  try {
    const open = await get(`/verify/opens/${id}`)
    if (open === null) return { kind: "notFound" }
    const openJson = objectOf(open, "the open")
    // Each answer must be the record that was asked for: the block is joined from their text, so an
    // answer for another record would be checked as if it were this open's.
    sameRecord(openJson, "winId", id, "the open")
    const seedPairId = field(openJson, "seedPairId", "the open")
    const editionId = field(openJson, "editionId", "the open")
    // `null` means "this open has no prize list"; a missing key means our server left the field out.
    if (!("snapshotHash" in openJson)) {
      throw new ServerFault("the open it sent leaves out its prize list fingerprint")
    }
    const snapshotHash = openJson.snapshotHash
    // Every value put into a path is checked for its shape first, so no answer can steer a request.
    if (snapshotHash !== null && (typeof snapshotHash !== "string" || !HASH.test(snapshotHash))) {
      throw new ServerFault("the open it sent has a prize list fingerprint that is not 64 hex characters")
    }
    const [seedPair, edition, snapshot] = await Promise.all([
      required(get, `/verify/seed-pairs/${seedPairId}`, "the seed pair"),
      required(get, `/verify/editions/${editionId}`, "the box"),
      snapshotHash === null ? null : required(get, `/verify/snapshots/${snapshotHash}`, "the prize list"),
    ])
    const seedPairJson = objectOf(seedPair, "the seed pair")
    sameRecord(seedPairJson, "seedPairId", seedPairId, "the seed pair")
    sameRecord(objectOf(edition, "the box"), "editionId", editionId, "the box")
    if (snapshot !== null) sameRecord(objectOf(snapshot, "the prize list"), "snapshotHash", snapshotHash as string, "the prize list", true)
    // `null` means "not revealed yet"; a missing key means our server left the field out.
    if (!("revealedServerSeed" in seedPairJson)) {
      throw new ServerFault("the seed pair it sent leaves out its revealed secret")
    }
    return { kind: "found", text: joinProof({ open, seedPair, edition, snapshot, itemId }) }
  } catch (error) {
    if (error instanceof TimedOut) return { kind: "timedOut" }
    if (error instanceof Unreachable) return { kind: "unreachable" }
    if (error instanceof ServerFault) return { kind: "serverFault", message: error.message }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** One GET; its body as text, or `null` for a 404. */
async function answer(fetchFn: typeof fetch, path: string, signal: AbortSignal): Promise<string | null> {
  let response: Response
  try {
    response = await fetchFn(`${API_BASE}${path}`, { method: "GET", credentials: "omit", cache: "no-store", signal })
  } catch {
    throw signal.aborted ? new TimedOut() : new Unreachable()
  }
  if (response.status === 404) return null
  if (!response.ok) throw new ServerFault(`it answered with error ${response.status}`)
  try {
    return await readCapped(response)
  } catch (error) {
    if (error instanceof ServerFault) throw error
    throw signal.aborted ? new TimedOut() : new Unreachable()
  }
}

async function required(get: (path: string) => Promise<string | null>, path: string, what: string): Promise<string> {
  const text = await get(path)
  if (text === null) throw new ServerFault(`it has no record of ${what} this open names`)
  return text
}

/** The body as text, read in pieces and refused as soon as it passes {@link MAX_ANSWER_BYTES}. */
async function readCapped(response: Response): Promise<string> {
  const tooLarge = () => new ServerFault(`one of its answers is larger than ${MAX_ANSWER_BYTES.toLocaleString("en")} bytes`)
  if (Number(response.headers.get("content-length") ?? 0) > MAX_ANSWER_BYTES) throw tooLarge()
  if (response.body === null) return ""
  const reader = response.body.getReader()
  // Fatal: a byte that is not UTF-8 is refused, so the box only ever holds what the server sent.
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let text = ""
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decode(decoder, undefined)
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel()
      throw tooLarge()
    }
    text += decode(decoder, value)
  }
}

function decode(decoder: TextDecoder, bytes: Uint8Array | undefined): string {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true })
  } catch {
    throw new ServerFault("one of its answers is not valid UTF-8 text")
  }
}

function objectOf(text: string, what: string): Record<string, unknown> {
  // A key written twice would be read as its last copy here, and refused later by the check: refuse
  // it now, so the lookup never reports a proof the check will not read.
  const problem = structureProblem(text)
  if (problem !== null) {
    throw new ServerFault(
      "tooDeep" in problem
        ? `${what} it sent is nested too deeply`
        : `${what} it sent names the field "${problem.duplicateKey}" twice`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ServerFault(`${what} it sent is not valid JSON`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerFault(`${what} it sent is not a JSON object`)
  }
  return value as Record<string, unknown>
}

function field(json: Record<string, unknown>, name: string, what: string): string {
  const value = json[name]
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ServerFault(`${what} it sent has no usable ${LABEL[name]}`)
  }
  return value
}

/** Ids are compared without letter case, as UUIDs are; a hash is compared exactly. */
function sameRecord(json: Record<string, unknown>, name: string, asked: string, what: string, exact = false) {
  const value = json[name]
  const same = typeof value === "string" && (exact ? value === asked : value.toLowerCase() === asked.toLowerCase())
  if (!same) {
    throw new ServerFault(`${what} it sent has a different ${LABEL[name]} from the one ${name === "winId" ? "you asked for" : "the open names"}`)
  }
}

/** The win id and item id in the page's address: `#open=<winId>&item=<itemId>`. Never sent anywhere. */
export function fromFragment(hash: string): { winId: string; itemId: string | null } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const winId = params.get("open")
  if (winId === null) return null
  const itemId = params.get("item")
  return { winId, itemId: itemId !== null && UUID.test(itemId) ? itemId : null }
}
