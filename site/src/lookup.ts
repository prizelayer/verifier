import { joinProof } from "./proof"

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

/** What a lookup gives the page: the proof as text, or a named reason why there is none. */
export type LookupResult =
  | { kind: "found"; text: string }
  | { kind: "notAnId" }
  | { kind: "notFound" }
  | { kind: "unreachable" }
  | { kind: "serverFault"; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A fault in our server's answer, as opposed to a network that did not answer at all. */
class ServerFault extends Error {}

/** The network did not answer: offline, blocked, or refused by the browser. */
class Unreachable extends Error {}

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
  try {
    const open = await answer(fetchFn, `/verify/opens/${id}`)
    if (open === null) return { kind: "notFound" }
    const openJson = objectOf(open, "the open")
    const seedPairId = field(openJson, "seedPairId", "the open")
    const editionId = field(openJson, "editionId", "the open")
    const snapshotHash = openJson.snapshotHash
    // Every value put into a path is checked for its shape first, so no answer can steer a request.
    if (snapshotHash != null && (typeof snapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(snapshotHash))) {
      throw new ServerFault("our server's answer for the open has a snapshotHash that is not 64 hex characters")
    }
    const [seedPair, edition, snapshot] = await Promise.all([
      required(fetchFn, `/verify/seed-pairs/${seedPairId}`, "the seed pair"),
      required(fetchFn, `/verify/editions/${editionId}`, "the box"),
      typeof snapshotHash === "string" ? required(fetchFn, `/verify/snapshots/${snapshotHash}`, "the prize list") : null,
    ])
    // Each answer must be the record that was asked for: the block is joined from their text, so an
    // answer for another record would be checked as if it were this open's.
    sameRecord(openJson, "winId", id, "the open")
    const seedPairJson = objectOf(seedPair, "the seed pair")
    sameRecord(seedPairJson, "seedPairId", seedPairId, "the seed pair")
    sameRecord(objectOf(edition, "the box"), "editionId", editionId, "the box")
    if (snapshot !== null) sameRecord(objectOf(snapshot, "the prize list"), "snapshotHash", snapshotHash as string, "the prize list")
    // `null` means "not revealed yet"; a missing key means our server left the field out.
    if (!("revealedServerSeed" in seedPairJson)) {
      throw new ServerFault("our server's answer for the seed pair has no revealedServerSeed field")
    }
    return { kind: "found", text: joinProof({ open, seedPair, edition, snapshot, itemId }) }
  } catch (error) {
    if (error instanceof Unreachable) return { kind: "unreachable" }
    if (error instanceof ServerFault) return { kind: "serverFault", message: error.message }
    throw error
  }
}

/** One GET; its body as text, or `null` for a 404. */
async function answer(fetchFn: typeof fetch, path: string): Promise<string | null> {
  let response: Response
  try {
    response = await fetchFn(`${API_BASE}${path}`, { method: "GET", credentials: "omit", cache: "no-store" })
  } catch {
    throw new Unreachable()
  }
  if (response.status === 404) return null
  if (!response.ok) throw new ServerFault(`our server answered ${response.status} for ${path}`)
  return readCapped(response, path)
}

async function required(fetchFn: typeof fetch, path: string, what: string): Promise<string> {
  const text = await answer(fetchFn, path)
  if (text === null) throw new ServerFault(`our server has no answer for ${what} this open names`)
  return text
}

/** The body as text, read in pieces and refused as soon as it passes {@link MAX_ANSWER_BYTES}. */
async function readCapped(response: Response, path: string): Promise<string> {
  const tooLarge = () => new ServerFault(`our server's answer for ${path} is larger than ${MAX_ANSWER_BYTES} bytes`)
  if (Number(response.headers.get("content-length") ?? 0) > MAX_ANSWER_BYTES) throw tooLarge()
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel()
      throw tooLarge()
    }
    text += decoder.decode(value, { stream: true })
  }
}

function objectOf(text: string, what: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ServerFault(`our server's answer for ${what} is not valid JSON`)
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerFault(`our server's answer for ${what} is not an object`)
  }
  return value as Record<string, unknown>
}

function field(json: Record<string, unknown>, name: string, what: string): string {
  const value = json[name]
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ServerFault(`our server's answer for ${what} has no usable ${name}`)
  }
  return value
}

function sameRecord(json: Record<string, unknown>, name: string, asked: string, what: string) {
  const value = json[name]
  if (typeof value !== "string" || value.toLowerCase() !== asked.toLowerCase()) {
    throw new ServerFault(`our server's answer for ${what} names another ${name} than the one the page asked for`)
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
