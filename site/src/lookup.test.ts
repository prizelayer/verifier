import { afterEach, describe, expect, it, vi } from "vitest"
import { EXAMPLE_PROOF } from "./example"
import { API_BASE, fromFragment, LOOKUP_TIMEOUT_MS, lookUp, MAX_ANSWER_BYTES } from "./lookup"
import { exampleAnswers, fakeServer, type Answer } from "./test/fakeServer"

const { open, seedPair, edition, snapshot, received } = EXAMPLE_PROOF
const WIN = open.winId

function found(result: Awaited<ReturnType<typeof lookUp>>): string {
  if (result.kind !== "found") throw new Error(`expected a proof, got ${JSON.stringify(result)}`)
  return result.text
}

function withAnswer(path: string, answer: Answer) {
  const answers = exampleAnswers()
  answers.set(path, answer)
  return fakeServer(answers)
}

describe("lookUp", () => {
  it("joins the four answers into the proof the paste path reads", async () => {
    const server = fakeServer(exampleAnswers())
    const proof = JSON.parse(found(await lookUp(WIN, received.itemId, server.fetchFn)))
    expect(proof).toEqual(EXAMPLE_PROOF)
  })

  it("asks for the open first, then the three answers it names, each a plain GET with no credentials", async () => {
    const server = fakeServer(exampleAnswers())
    await lookUp(WIN, null, server.fetchFn)
    expect(server.calls[0].url).toBe(`${API_BASE}/verify/opens/${WIN}`)
    expect(server.calls.map((call) => call.url).sort()).toEqual(
      [
        `${API_BASE}/verify/opens/${WIN}`,
        `${API_BASE}/verify/seed-pairs/${seedPair.seedPairId}`,
        `${API_BASE}/verify/editions/${edition.editionId}`,
        `${API_BASE}/verify/snapshots/${snapshot.snapshotHash}`,
      ].sort(),
    )
    for (const call of server.calls) {
      expect(call.init?.method).toBe("GET")
      expect(call.init?.credentials).toBe("omit")
      // A custom header would make the browser send a preflight request first.
      expect(call.init?.headers).toBeUndefined()
    }
  })

  it("adds no received item when the address carried none", async () => {
    const proof = JSON.parse(found(await lookUp(WIN, null, fakeServer(exampleAnswers()).fetchFn)))
    expect(proof).not.toHaveProperty("received")
  })

  it("keeps the answers' own text, so a value above 2^53 keeps every digit", async () => {
    const big = `{"snapshotHash":"${snapshot.snapshotHash}","editionId":"${snapshot.editionId}","editionFingerprint":"${snapshot.editionFingerprint}","body":{"displayed_value_cents":12345678901234567891}}`
    const text = found(await lookUp(WIN, null, withAnswer(`/verify/snapshots/${snapshot.snapshotHash}`, { status: 200, body: big }).fetchFn))
    expect(text).toContain(`"snapshot":${big}`)
    expect(text).toContain("12345678901234567891")
  })

  it("asks nothing for a text that is not an open id", async () => {
    const server = fakeServer(exampleAnswers())
    expect(await lookUp("not-an-id", null, server.fetchFn)).toEqual({ kind: "notAnId" })
    expect(server.calls).toEqual([])
  })

  it.each([`${WIN}/../x`, `x${WIN}`, `${WIN}%2F`, `${WIN}/../../seed-pairs/x`])(
    "asks nothing for %s, which only contains an open id",
    async (typed) => {
      const server = fakeServer(exampleAnswers())
      expect(await lookUp(typed, null, server.fetchFn)).toEqual({ kind: "notAnId" })
      expect(server.calls).toEqual([])
    },
  )

  it("says no open was found on a 404 for the open", async () => {
    const server = fakeServer(new Map())
    expect(await lookUp(WIN, null, server.fetchFn)).toEqual({ kind: "notFound" })
    expect(server.calls).toHaveLength(1)
  })

  it("says our server could not be reached when the request itself fails", async () => {
    const refused = (async () => {
      throw new TypeError("Failed to fetch")
    }) as typeof fetch
    expect(await lookUp(WIN, null, refused)).toEqual({ kind: "unreachable" })
  })

  it("names an error status as a fault of our server", async () => {
    const result = await lookUp(WIN, null, withAnswer(`/verify/opens/${WIN}`, { status: 500, body: "" }).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "it answered with error 500" })
  })

  it("names a 404 for a record the open names as a fault of our server", async () => {
    const result = await lookUp(WIN, null, withAnswer(`/verify/editions/${edition.editionId}`, { status: 404, body: "" }).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "it has no record of the box this open names" })
  })

  it("reads a seed pair whose secret is not revealed yet (null) as a proof", async () => {
    const pending = JSON.stringify({ ...seedPair, status: "active", revealedServerSeed: null, retiredAt: null, retirementReason: null })
    const text = found(await lookUp(WIN, null, withAnswer(`/verify/seed-pairs/${seedPair.seedPairId}`, { status: 200, body: pending }).fetchFn))
    expect(JSON.parse(text).seedPair.revealedServerSeed).toBeNull()
  })

  it("names a seed pair answer with no revealedServerSeed field as a fault of our server", async () => {
    const { revealedServerSeed: _dropped, ...withoutField } = seedPair
    const result = await lookUp(WIN, null, withAnswer(`/verify/seed-pairs/${seedPair.seedPairId}`, { status: 200, body: JSON.stringify(withoutField) }).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "the seed pair it sent leaves out its revealed secret" })
  })

  it("asks for no prize list when the open names none", async () => {
    const server = withAnswer(`/verify/opens/${WIN}`, { status: 200, body: JSON.stringify({ ...open, snapshotHash: null }) })
    const proof = JSON.parse(found(await lookUp(WIN, null, server.fetchFn)))
    expect(proof).not.toHaveProperty("snapshot")
    expect(server.calls.map((call) => call.url).filter((url) => url.includes("/snapshots/"))).toEqual([])
  })

  it.each([
    ["seedPairId", "../editions/x"],
    ["seedPairId", `${seedPair.seedPairId}/../x`],
    ["seedPairId", `x${seedPair.seedPairId}`],
    ["editionId", null],
    ["snapshotHash", "19159c52/../x"],
    ["snapshotHash", `${snapshot.snapshotHash}/../x`],
  ])("refuses an open whose %s cannot be put in a path, and asks nothing more", async (name, value) => {
    const server = withAnswer(`/verify/opens/${WIN}`, { status: 200, body: JSON.stringify({ ...open, [name]: value }) })
    const result = await lookUp(WIN, null, server.fetchFn)
    expect(result.kind).toBe("serverFault")
    expect(server.calls).toHaveLength(1)
  })

  it.each([
    ["the open", `/verify/opens/${WIN}`, "winId", "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d", "win id from the one you asked for"],
    ["the seed pair", `/verify/seed-pairs/${seedPair.seedPairId}`, "seedPairId", "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d", "seed pair id from the one the open names"],
    ["the box", `/verify/editions/${edition.editionId}`, "editionId", "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d", "box id from the one the open names"],
    ["the prize list", `/verify/snapshots/${snapshot.snapshotHash}`, "snapshotHash", "0".repeat(64), "fingerprint from the one the open names"],
  ])("names an answer for %s that is another record as a fault of our server", async (what, path, name, other, differs) => {
    const answers = exampleAnswers()
    answers.set(path, { status: 200, body: JSON.stringify({ ...JSON.parse(answers.get(path)!.body), [name]: other }) })
    const server = fakeServer(answers)
    expect(await lookUp(WIN, null, server.fetchFn)).toEqual({
      kind: "serverFault",
      message: `${what} it sent has a different ${differs}`,
    })
    // A wrong open is refused before anything else is asked.
    if (what === "the open") expect(server.calls).toHaveLength(1)
  })

  it("compares a hash exactly: a prize list naming the hash in upper case is another record", async () => {
    const path = `/verify/snapshots/${snapshot.snapshotHash}`
    const upper = JSON.stringify({ ...snapshot, snapshotHash: snapshot.snapshotHash.toUpperCase() })
    expect(await lookUp(WIN, null, withAnswer(path, { status: 200, body: upper }).fetchFn)).toEqual({
      kind: "serverFault",
      message: "the prize list it sent has a different fingerprint from the one the open names",
    })
  })

  it("names an open answer with no snapshotHash field as a fault of our server, and asks nothing more", async () => {
    const { snapshotHash: _dropped, ...withoutField } = open
    const server = withAnswer(`/verify/opens/${WIN}`, { status: 200, body: JSON.stringify(withoutField) })
    expect(await lookUp(WIN, null, server.fetchFn)).toEqual({
      kind: "serverFault",
      message: "the open it sent leaves out its prize list fingerprint",
    })
    expect(server.calls).toHaveLength(1)
  })

  it("refuses an answer with a key written twice, before anything is reported as found", async () => {
    const body = `{"winId":"0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d",${JSON.stringify(open).slice(1)}`
    const server = withAnswer(`/verify/opens/${WIN}`, { status: 200, body })
    expect(await lookUp(WIN, null, server.fetchFn)).toEqual({
      kind: "serverFault",
      message: `the open it sent names the field "winId" twice`,
    })
    expect(server.calls).toHaveLength(1)
  })

  it("refuses an answer that is not UTF-8", async () => {
    const text = new TextEncoder().encode(JSON.stringify(open))
    const bad = new Uint8Array([...text.slice(0, 20), 0xff, ...text.slice(20)])
    const server = fakeServer(exampleAnswers())
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith(`/verify/opens/${WIN}`) ? new Response(bad, { status: 200 }) : server.fetchFn(url, init)) as typeof fetch
    expect(await lookUp(WIN, null, fetchFn)).toEqual({
      kind: "serverFault",
      message: "one of its answers is not valid UTF-8 text",
    })
  })

  it("accepts the open's own id in another letter case", async () => {
    expect((await lookUp(WIN.toUpperCase(), null, withAnswer(`/verify/opens/${WIN.toUpperCase()}`, { status: 200, body: JSON.stringify(open) }).fetchFn)).kind).toBe("found")
  })

  it("names an answer that is not JSON", async () => {
    const result = await lookUp(WIN, null, withAnswer(`/verify/editions/${edition.editionId}`, { status: 200, body: "<html>" }).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "the box it sent is not valid JSON" })
  })

  it("refuses an answer larger than the cap, and reads one at the cap", async () => {
    const path = `/verify/editions/${edition.editionId}`
    const atCap = JSON.stringify(edition)
    const padded = atCap.slice(0, -1) + `,"pad":"${"x".repeat(MAX_ANSWER_BYTES - atCap.length - 9)}"}`
    expect(padded.length).toBe(MAX_ANSWER_BYTES)
    expect((await lookUp(WIN, null, withAnswer(path, { status: 200, body: padded }).fetchFn)).kind).toBe("found")
    const over = padded.slice(0, -2) + `x"}`
    expect(over.length).toBe(MAX_ANSWER_BYTES + 1)
    // Compared field by field: a failure must print a kind and a sentence, never the 1 MB answer.
    const result = await lookUp(WIN, null, withAnswer(path, { status: 200, body: over }).fetchFn)
    expect(result.kind).toBe("serverFault")
    expect("message" in result ? result.message : undefined).toBe(
      `one of its answers is larger than ${MAX_ANSWER_BYTES.toLocaleString("en")} bytes`,
    )
  })

  it("refuses an answer whose declared length is over the cap before reading it", async () => {
    // An answer that is otherwise good, so only the cap can refuse it.
    const server = fakeServer(exampleAnswers())
    const declared = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await server.fetchFn(url, init)
      return new Response(response.body, { status: 200, headers: { "content-length": String(MAX_ANSWER_BYTES + 1) } })
    }) as typeof fetch
    expect(await lookUp(WIN, null, declared)).toEqual({
      kind: "serverFault",
      message: `one of its answers is larger than ${MAX_ANSWER_BYTES.toLocaleString("en")} bytes`,
    })
  })
})

describe("a lookup that takes too long", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A fetch that never answers, and fails as a fetch does once its signal is aborted. */
  const silent = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })) as typeof fetch

  it("stops after the time limit when our server never answers, and every request carried the signal", async () => {
    vi.useFakeTimers()
    const result = lookUp(WIN, null, silent)
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS - 1)
    let settled = false
    void result.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ kind: "timedOut" })
  })

  it("stops after the time limit when an answer starts and then stalls", async () => {
    vi.useFakeTimers()
    const stalling = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"winId":'))
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")))
        },
      })
      return new Response(body, { status: 200 })
    }) as typeof fetch
    const result = lookUp(WIN, null, stalling)
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS)
    expect(await result).toEqual({ kind: "timedOut" })
  })
})

describe("fromFragment", () => {
  it("reads the open id and the item id", () => {
    expect(fromFragment(`#open=${WIN}&item=${received.itemId}`)).toEqual({ winId: WIN, itemId: received.itemId })
  })
  it("drops an item id that is not an id", () => {
    expect(fromFragment(`#open=${WIN}&item=nope`)).toEqual({ winId: WIN, itemId: null })
  })
  it("reads nothing from an address without an open", () => {
    expect(fromFragment("")).toBeNull()
    expect(fromFragment(`#item=${received.itemId}`)).toBeNull()
  })
})
