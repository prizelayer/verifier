import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup } from "@testing-library/react"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { API_BASE, lookUp } from "./lookup"
import { exampleAnswers, fakeServer } from "./test/fakeServer"
import { FIRST_VISIT, LOCKED, LOOKUP_WORDS, STEPS } from "./words"

/**
 * The first visit: the block above the inputs, the id the lookup expects, what a lookup
 * sends, the pending verdict's colour and words, and where each step's values come from. The words
 * are the page's public text, so the literals here pin them exactly.
 */
afterEach(cleanup)

const WIN = EXAMPLE_PROOF.open.winId

describe("the first-visit block", () => {
  it("sits above the lookup, and says where the id comes from, what is never typed, and what pending means", () => {
    render(<App />)
    const block = document.querySelector("[data-first-visit]") as HTMLElement
    const lookup = screen.getByText("Look up an open by its id")
    expect(block.compareDocumentPosition(lookup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(block.querySelector("h2")?.textContent).toBe("How to check one of your opens")
    expect([...block.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      FIRST_VISIT.link,
      FIRST_VISIT.noTyping,
      FIRST_VISIT.pending,
    ])
    // The header keeps its own line pointing there, so the block has no fifth sentence that repeats it.
    expect(document.body.textContent).toContain('Read "What this does not prove" below. It is short, and it matters.')
    expect(document.body.textContent).not.toContain("is at the end of the page under")
  })

  it("prints the approved F3 sentence word for word", () => {
    expect(FIRST_VISIT.noTyping).toBe(
      'You never type a seed or a box here. "Look up" fetches the public records of that open from our server: the open, its seed pair, its box and its prize list. Your browser reads the secret, the client seed and the chances from those records, and redoes the pick itself. It sends our server nothing but the open\'s id and the ids our server gives back for it.',
    )
  })
})

describe("the id the lookup expects", () => {
  it("shows an example id as the placeholder, and a help line tied to the field", () => {
    render(<App />)
    const field = screen.getByRole("textbox", { name: "Look up an open by its id" }) as HTMLTextAreaElement
    expect(field.placeholder).toBe("e.g. 7c9e6679-7425-40de-944b-e07fc1f90ae7")
    const help = document.getElementById((field.getAttribute("aria-describedby") ?? "").split(" ")[0])
    expect(help?.textContent).toBe(LOOKUP_WORDS.help)
  })

  it("fetches an id typed in upper case, with spaces around it, in lower case", async () => {
    const server = fakeServer(exampleAnswers())
    const result = await lookUp(`  ${WIN.toUpperCase()} `, null, server.fetchFn)
    expect(result.kind).toBe("found")
    expect(server.calls[0].url).toBe(`${API_BASE}/verify/opens/${WIN}`)
  })

  it("shows the lower-case id in the field after the press", async () => {
    const server = fakeServer(exampleAnswers())
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    const field = screen.getByRole("textbox", { name: "Look up an open by its id" }) as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: WIN.toUpperCase() } })
    await user.click(screen.getByRole("button", { name: "Look up" }))
    await waitFor(() => expect(document.querySelector("[data-status] p")?.textContent).toBe("PASS"))
    expect(field.value).toBe(WIN)
  })

  it("fetches nothing for a text that is not an id", async () => {
    const server = fakeServer(exampleAnswers())
    expect((await lookUp("7c9e6679-7425-40de-944b-e07fc1f90ae", null, server.fetchFn)).kind).toBe("notAnId")
    expect((await lookUp("not-an-id", null, server.fetchFn)).kind).toBe("notAnId")
    expect(server.calls).toEqual([])
  })
})

describe("what a lookup sends our server (F3: nothing but the open's id and the ids it gives back)", () => {
  it("makes at most four plain GETs, to the four public routes, with no query, body or header", async () => {
    const server = fakeServer(exampleAnswers())
    expect((await lookUp(WIN.toUpperCase(), null, server.fetchFn)).kind).toBe("found")
    const { open } = EXAMPLE_PROOF
    // Every id after the first is the value in the open's own answer, never one the page made up.
    expect(server.calls.map((c) => c.url).sort()).toEqual(
      [
        `${API_BASE}/verify/opens/${WIN}`,
        `${API_BASE}/verify/seed-pairs/${open.seedPairId}`,
        `${API_BASE}/verify/editions/${open.editionId}`,
        `${API_BASE}/verify/snapshots/${open.snapshotHash}`,
      ].sort(),
    )
    expect(server.calls[0].url).toBe(`${API_BASE}/verify/opens/${WIN}`)
    for (const { url, init } of server.calls) {
      expect(url).not.toContain("?")
      expect(url).not.toContain("#")
      expect(init?.method).toBe("GET")
      expect(init?.body).toBeUndefined()
      expect(init?.headers).toBeUndefined()
      expect(Object.keys(init ?? {}).sort()).toEqual(["cache", "credentials", "method", "signal"])
    }
  })
})

describe("the pending verdict", () => {
  it("prints the approved LOCKED sentence word for word", () => {
    expect(LOCKED).toBe(
      "The secret for this open is still locked, because it is still being used for your next opens. " +
        'It is revealed when you press "Start a new pair", or, once its pair has served 1,000 opens or is more than 24 hours old, at your next open or your next visit to a box page. ' +
        '"Start a new pair" is in the player page, under the Open button, in Details. ' +
        "Until then your browser can check the chances (step 2) and, when the proof has one, the prize list, but not the pick itself.",
    )
  })

  it("shows CANNOT CHECK YET in the neutral ink, never in the colour of a pass or a fail", async () => {
    const proof = structuredClone(EXAMPLE_PROOF) as unknown as { seedPair: Record<string, unknown> }
    proof.seedPair.revealedServerSeed = null
    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(screen.getByRole("textbox", { name: "Paste a proof" }), { target: { value: JSON.stringify(proof) } })
    await user.click(screen.getByRole("button", { name: "Check" }))
    const word = await waitFor(() => {
      const p = document.querySelector("[data-status] p")
      expect(p?.textContent).toBe("CANNOT CHECK YET")
      return p as HTMLElement
    })
    expect(word.classList.contains("text-muted-foreground")).toBe(true)
    for (const tone of ["text-ok", "text-fail", "text-pending"]) expect(word.classList.contains(tone)).toBe(false)
  })
})

describe("where each step's values come from", () => {
  // The proof a lookup with an item id would build: the four records and the item from the link.
  const proof: Record<string, unknown> = { ...EXAMPLE_PROOF }

  const resolve = (path: string) =>
    path.split(".").reduce<unknown>((at, key) => (at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined), proof)

  it("names in every source line only fields the proof has", () => {
    for (const { step, source } of STEPS) {
      const names = source.split("`").filter((_, i) => i % 2 === 1)
      expect(names.length, `step ${step}`).toBeGreaterThan(0)
      for (const name of names) expect(resolve(name), `step ${step}: ${name}`).not.toBeUndefined()
    }
  })

  it("says the received item is not a public record", () => {
    expect(STEPS[3].source).toBe(
      "Read from the box record: the ranges of `edition`; from the open record: `open.drawnSlotIndex` and `open.snapshotHash`; from the prize list record: `snapshot.body`. The item you received, `received.itemId`, is not a public record: it came from the link you followed.",
    )
  })

  it("shows each step's source line under its title, before and after a check", async () => {
    const user = userEvent.setup()
    render(<App />)
    const lines = () => [...document.querySelectorAll("[data-step] [data-source]")].map((p) => p.textContent)
    const plain = STEPS.map(({ source }) => source.replaceAll("`", ""))
    expect(lines()).toEqual(plain)
    await user.click(screen.getByRole("button", { name: "Try the example" }))
    await waitFor(() => expect(document.querySelector("[data-status] p")?.textContent).toBe("PASS"))
    expect(lines()).toEqual(plain)
    expect(document.querySelectorAll("[data-step] [data-source] code").length).toBe(13)
  })
})
