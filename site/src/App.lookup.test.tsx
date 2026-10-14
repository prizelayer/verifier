import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { exampleAnswers, fakeServer } from "./test/fakeServer"
import { LOOKUP_WORDS, NOT_TOLD_ITEM } from "./words"

const WIN = EXAMPLE_PROOF.open.winId
const ITEM = EXAMPLE_PROOF.received.itemId
const MARKUP = '<img id="injected" src="x">'

afterEach(() => {
  cleanup()
  window.location.hash = ""
})

const verdict = () => document.querySelector("[data-status] p")?.textContent ?? null
const box = () => screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement
const idField = () => screen.getByRole("textbox", { name: "Look up an open by its id" }) as HTMLInputElement

function openWithHash(hash: string, server = fakeServer(exampleAnswers())) {
  window.location.hash = hash
  const user = userEvent.setup()
  render(<App fetchFn={server.fetchFn} />)
  return { user, server }
}

describe("the lookup", () => {
  it("fetches nothing before the button is pressed, also when the id came in the address", async () => {
    const { user, server } = openWithHash(`#open=${WIN}&item=${ITEM}`)
    expect(idField().value).toBe(WIN)
    await user.click(screen.getByRole("button", { name: "Try the example" }))
    await waitFor(() => expect(verdict()).toBe("PASS"))
    expect(server.calls).toEqual([])
  })

  it("puts the fetched proof in the box, checks it, and offers to save it", async () => {
    const { user, server } = openWithHash(`#open=${WIN}&item=${ITEM}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdict()).toBe("PASS"))
    expect(server.calls).toHaveLength(4)
    expect(JSON.parse(box().value)).toEqual(EXAMPLE_PROOF)
    expect(screen.getByText(LOOKUP_WORDS.found)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Save this proof" })).toBeTruthy()
    expect(screen.getByText(LOOKUP_WORDS.sharing)).toBeTruthy()
  })

  it("checks a lookup without an item id, and says the item was not checked", async () => {
    const { user } = openWithHash(`#open=${WIN}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdict()).toBe("PASS"))
    expect(JSON.parse(box().value)).not.toHaveProperty("received")
    expect(document.querySelector("main")?.textContent).toContain(NOT_TOLD_ITEM)
  })

  it("drops the address's item id when another open id is typed", async () => {
    const other = "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"
    const answers = exampleAnswers()
    answers.set(`/verify/opens/${other}`, { status: 200, body: JSON.stringify({ ...EXAMPLE_PROOF.open, winId: other }) })
    const { user, server } = openWithHash(`#open=${WIN}&item=${ITEM}`, fakeServer(answers))
    await user.clear(idField())
    await user.type(idField(), other)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdict()).toBe("PASS"))
    expect(server.calls[0].url).toContain(`/verify/opens/${other}`)
    expect(JSON.parse(box().value)).not.toHaveProperty("received")
  })

  it("hides 'Save this proof' once the box no longer holds the fetched proof", async () => {
    const { user } = openWithHash(`#open=${WIN}&item=${ITEM}`)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdict()).toBe("PASS"))
    await user.type(box(), " ")
    expect(screen.queryByRole("button", { name: "Save this proof" })).toBeNull()
  })

  it.each([
    ["no open with this id", fakeServer(new Map()), LOOKUP_WORDS.notFound],
    [
      "a network that does not answer",
      { fetchFn: (async () => { throw new TypeError("Failed to fetch") }) as typeof fetch, calls: [] },
      LOOKUP_WORDS.unreachable,
    ],
  ])("says so for %s, and checks nothing", async (_name, server, words) => {
    const { user } = openWithHash(`#open=${WIN}`, server)
    await user.click(screen.getByRole("button", { name: "Look up" }))
    expect(await screen.findByText(words)).toBeTruthy()
    expect(verdict()).toBeNull()
    expect(box().value).toBe("")
  })

  it("shows a seed pair answer without its seed field as a fault of our server, and checks nothing", async () => {
    const answers = exampleAnswers()
    const { revealedServerSeed: _dropped, ...withoutField } = EXAMPLE_PROOF.seedPair
    answers.set(`/verify/seed-pairs/${EXAMPLE_PROOF.seedPair.seedPairId}`, { status: 200, body: JSON.stringify(withoutField) })
    const { user } = openWithHash(`#open=${WIN}`, fakeServer(answers))
    await user.click(screen.getByRole("button", { name: "Look up" }))
    expect(
      await screen.findByText(LOOKUP_WORDS.serverFault("our server's answer for the seed pair has no revealedServerSeed field")),
    ).toBeTruthy()
    expect(verdict()).toBeNull()
    expect(box().value).toBe("")
  })

  it.each([
    ["the client seed", `/verify/seed-pairs/${EXAMPLE_PROOF.seedPair.seedPairId}`, (body: Record<string, unknown>) => ({ ...body, clientSeed: MARKUP })],
    [
      "a value of the box",
      `/verify/editions/${EXAMPLE_PROOF.edition.editionId}`,
      (body: Record<string, unknown>) => ({
        ...body,
        slots: EXAMPLE_PROOF.edition.slots.map((slot, i) => (i === 0 ? { ...slot, requiredBuyBackValueCents: MARKUP } : slot)),
      }),
    ],
  ])("shows markup in %s of a fetched answer as text, never as markup", async (_what, path, change) => {
    const answers = exampleAnswers()
    answers.set(path, { status: 200, body: JSON.stringify(change(JSON.parse(answers.get(path)!.body))) })
    const { user } = openWithHash(`#open=${WIN}`, fakeServer(answers))
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(verdict()).not.toBeNull())
    expect(document.getElementById("injected")).toBeNull()
    expect(document.querySelector("main img")).toBeNull()
    expect(document.querySelector("main")?.textContent).toContain(MARKUP)
  })
})
