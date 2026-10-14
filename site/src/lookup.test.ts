import { describe, expect, it } from "vitest"
import { EXAMPLE_PROOF } from "./example"
import { API_BASE, fromFragment, lookUp, MAX_ANSWER_BYTES } from "./lookup"
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
    expect(result).toEqual({ kind: "serverFault", message: `our server answered 500 for /verify/opens/${WIN}` })
  })

  it("names a 404 for a record the open names as a fault of our server", async () => {
    const result = await lookUp(WIN, null, withAnswer(`/verify/editions/${edition.editionId}`, { status: 404, body: "" }).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "our server has no answer for the box this open names" })
  })

  it("reads a seed pair whose secret is not revealed yet (null) as a proof", async () => {
    const pending = JSON.stringify({ ...seedPair, status: "active", revealedServerSeed: null, retiredAt: null, retirementReason: null })
    const text = found(await lookUp(WIN, null, withAnswer(`/verify/seed-pairs/${seedPair.seedPairId}`, { status: 200, body: pending }).fetchFn))
    expect(JSON.parse(text).seedPair.revealedServerSeed).toBeNull()
  })

  it("names a seed pair answer with no revealedServerSeed field as a fault of our server", async () => {
    const { revealedServerSeed: _dropped, ...withoutField } = seedPair
    const result = await lookUp(WIN, null, withAnswer(`/verify/seed-pairs/${seedPair.seedPairId}`, { status: 200, body: JSON.stringify(withoutField) }).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "our server's answer for the seed pair has no revealedServerSeed field" })
  })

  it("asks for no prize list when the open names none", async () => {
    const server = withAnswer(`/verify/opens/${WIN}`, { status: 200, body: JSON.stringify({ ...open, snapshotHash: null }) })
    const proof = JSON.parse(found(await lookUp(WIN, null, server.fetchFn)))
    expect(proof).not.toHaveProperty("snapshot")
    expect(server.calls.map((call) => call.url).filter((url) => url.includes("/snapshots/"))).toEqual([])
  })

  it.each([
    ["seedPairId", "../editions/x"],
    ["editionId", null],
    ["snapshotHash", "19159c52/../x"],
  ])("refuses an open whose %s cannot be put in a path, and asks nothing more", async (name, value) => {
    const server = withAnswer(`/verify/opens/${WIN}`, { status: 200, body: JSON.stringify({ ...open, [name]: value }) })
    const result = await lookUp(WIN, null, server.fetchFn)
    expect(result.kind).toBe("serverFault")
    expect(server.calls).toHaveLength(1)
  })

  it.each([
    ["the open", `/verify/opens/${WIN}`, "winId", "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"],
    ["the seed pair", `/verify/seed-pairs/${seedPair.seedPairId}`, "seedPairId", "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"],
    ["the box", `/verify/editions/${edition.editionId}`, "editionId", "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"],
    ["the prize list", `/verify/snapshots/${snapshot.snapshotHash}`, "snapshotHash", "0".repeat(64)],
  ])("names an answer for %s that is another record as a fault of our server", async (what, path, name, other) => {
    const answers = exampleAnswers()
    answers.set(path, { status: 200, body: JSON.stringify({ ...JSON.parse(answers.get(path)!.body), [name]: other }) })
    expect(await lookUp(WIN, null, fakeServer(answers).fetchFn)).toEqual({
      kind: "serverFault",
      message: `our server's answer for ${what} names another ${name} than the one the page asked for`,
    })
  })

  it("accepts the open's own id in another letter case", async () => {
    expect((await lookUp(WIN.toUpperCase(), null, withAnswer(`/verify/opens/${WIN.toUpperCase()}`, { status: 200, body: JSON.stringify(open) }).fetchFn)).kind).toBe("found")
  })

  it("names an answer that is not JSON", async () => {
    const result = await lookUp(WIN, null, withAnswer(`/verify/editions/${edition.editionId}`, { status: 200, body: "<html>" }).fetchFn)
    expect(result).toEqual({ kind: "serverFault", message: "our server's answer for the box is not valid JSON" })
  })

  it("refuses an answer larger than the cap, and reads one at the cap", async () => {
    const path = `/verify/editions/${edition.editionId}`
    const atCap = JSON.stringify(edition)
    const padded = atCap.slice(0, -1) + `,"pad":"${"x".repeat(MAX_ANSWER_BYTES - atCap.length - 9)}"}`
    expect(padded).toHaveLength(MAX_ANSWER_BYTES)
    expect((await lookUp(WIN, null, withAnswer(path, { status: 200, body: padded }).fetchFn)).kind).toBe("found")
    const over = padded.slice(0, -2) + `x"}`
    expect(over).toHaveLength(MAX_ANSWER_BYTES + 1)
    expect(await lookUp(WIN, null, withAnswer(path, { status: 200, body: over }).fetchFn)).toEqual({
      kind: "serverFault",
      message: `our server's answer for ${path} is larger than ${MAX_ANSWER_BYTES} bytes`,
    })
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
      message: `our server's answer for /verify/opens/${WIN} is larger than ${MAX_ANSWER_BYTES} bytes`,
    })
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
