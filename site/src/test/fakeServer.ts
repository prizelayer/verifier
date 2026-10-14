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
