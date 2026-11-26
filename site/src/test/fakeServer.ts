import { API_BASE } from "../lookup"
import { EXAMPLE_PROOF } from "../example"

/** One answer of the fake server: a status and the body's exact text. */
export type Answer = { status: number; body: string }

/** The four public answers of the example open, as our server would serve them. */
export function exampleAnswers(): Map<string, Answer> {
  const { open, seedPair, edition, snapshot } = EXAMPLE_PROOF
  return new Map([
    [`/verify/opens/${open.winId}`, { status: 200, body: JSON.stringify(open) }],
    [`/verify/seed-pairs/${seedPair.seedPairId}`, { status: 200, body: JSON.stringify(seedPair) }],
    [`/verify/editions/${edition.editionId}`, { status: 200, body: JSON.stringify(edition) }],
    [`/verify/snapshots/${snapshot.snapshotHash}`, { status: 200, body: JSON.stringify(snapshot) }],
  ])
}

/** A `fetch` that answers from `answers` (404 for any other path) and records every call it got. */
export function fakeServer(answers: Map<string, Answer>) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    calls.push({ url: href, init })
    const path = href.startsWith(API_BASE) ? href.slice(API_BASE.length) : href
    const answer = answers.get(path) ?? { status: 404, body: "" }
    return new Response(answer.status === 404 ? null : answer.body, { status: answer.status })
  }) as typeof fetch
  return { fetchFn, calls }
}

/**
 * What our server's seed pair answer says about the pair since V070 (KAN-935 PR-2c): a pair the
 * page showed before its first open, whose client seed the player set. The hash is made up. The page
 * reads only the last two fields; the first is served as our server sends it, and step 1 ignores it.
 */
export const PAIR_RECORD = {
  shownBeforeFirstOpen: true,
  clientSeedSetByPlayer: true,
  setEventRecordHash: "5c0e2b7a9d14f3e8c6a1b0d2e4f6a8c0b1d3e5f7a9c2e4f6b8d0a1c3e5f7a9b2",
} as const

/**
 * The example's answers with `record` merged into the seed pair answer. `record` may hold any value,
 * so a test can serve a field our server would never send.
 */
export function pairAnswers(record: Record<string, unknown>): Map<string, Answer> {
  const answers = exampleAnswers()
  const { seedPair } = EXAMPLE_PROOF
  answers.set(`/verify/seed-pairs/${seedPair.seedPairId}`, { status: 200, body: JSON.stringify({ ...seedPair, ...record }) })
  return answers
}
