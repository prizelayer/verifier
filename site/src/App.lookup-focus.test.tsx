import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { layOut } from "./layOut"
import { LOOKUP_TIMEOUT_MS } from "./lookup"
import { exampleAnswers, fakeServer } from "./test/fakeServer"
import { LOOKUP_WORDS } from "./words"

const WIN = EXAMPLE_PROOF.open.winId

afterEach(() => {
  cleanup()
  window.location.hash = ""
  vi.useRealTimers()
})

const lookUpButton = () => screen.getByRole("button", { name: "Look up" }) as HTMLButtonElement
const idField = () => screen.getByRole("textbox", { name: "Look up an open by its id" }) as HTMLTextAreaElement
const box = () => screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement

/** The example server, with every answer held back until `release` is called. */
function heldServer() {
  const server = fakeServer(exampleAnswers())
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const asked: string[] = []
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(String(url))
    await held
    return server.fetchFn(url, init)
  }) as typeof fetch
  return { fetchFn, asked, release: () => release() }
}

const unreachable = (async () => {
  throw new TypeError("Failed to fetch")
}) as typeof fetch
const faulty = fakeServer(new Map([[`/verify/opens/${WIN}`, { status: 500, body: "" }]])).fetchFn

describe("the focus around a lookup", () => {
  it("stays on Look up while the lookup runs, and a second press is ignored", async () => {
    window.location.hash = `#open=${WIN}`
    const server = heldServer()
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    await user.click(lookUpButton())
    // aria-disabled, not disabled: a disabled button would drop the focus to the page.
    expect(lookUpButton().disabled).toBe(false)
    expect(lookUpButton().getAttribute("aria-disabled")).toBe("true")
    expect(document.activeElement).toBe(lookUpButton())
    await user.click(lookUpButton())
    await user.keyboard("{Enter}")
    expect(server.asked).toHaveLength(1)
    server.release()
    await waitFor(() => expect(document.querySelector("[data-status] p")?.textContent).toBe("PASS"))
    expect(lookUpButton().getAttribute("aria-disabled")).toBeNull()
  })

  it.each([
    ["not found", fakeServer(new Map()).fetchFn, LOOKUP_WORDS.notFound],
    ["unreachable", unreachable, LOOKUP_WORDS.unreachable],
    ["a faulty answer", faulty, LOOKUP_WORDS.serverFault("it answered with error 500")],
  ])("stays on Look up when the lookup ends in %s", async (_name, fetchFn, words) => {
    window.location.hash = `#open=${WIN}`
    const user = userEvent.setup()
    render(<App fetchFn={fetchFn} />)
    await user.click(lookUpButton())
    expect(await screen.findByText(words)).toBeTruthy()
    expect(document.activeElement).toBe(lookUpButton())
  })

  it("stays on Look up when the lookup times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.location.hash = `#open=${WIN}`
    const silent = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })) as typeof fetch
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App fetchFn={silent} />)
    await user.click(lookUpButton())
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS)
    expect(await screen.findByText(LOOKUP_WORDS.timedOut)).toBeTruthy()
    expect(document.activeElement).toBe(lookUpButton())
  })

  it("moves to the verdict when the lookup finds the open", async () => {
    window.location.hash = `#open=${WIN}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(exampleAnswers()).fetchFn} />)
    await user.click(lookUpButton())
    await waitFor(() => expect(document.querySelector("[data-status] p")?.textContent).toBe("PASS"))
    expect(document.activeElement?.contains(document.querySelector("[data-status]"))).toBe(true)
  })
})

describe("the id field", () => {
  it("runs the lookup on Enter, and ties a refusal to the field", async () => {
    const server = fakeServer(exampleAnswers())
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    await user.click(idField())
    await user.keyboard("not-an-id{Enter}")
    expect(await screen.findByText(LOOKUP_WORDS.notAnId)).toBeTruthy()
    expect(idField().value).toBe("not-an-id")
    expect(idField().getAttribute("aria-invalid")).toBe("true")
    const described = document.getElementById(idField().getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toBe(LOOKUP_WORDS.notAnId)
    await user.clear(idField())
    await user.keyboard(`${WIN}{Enter}`)
    await waitFor(() => expect(document.querySelector("[data-status] p")?.textContent).toBe("PASS"))
    expect(server.calls.length).toBeGreaterThan(0)
    expect(idField().getAttribute("aria-invalid")).toBeNull()
  })

  it("keeps a pasted id on one line", async () => {
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(exampleAnswers()).fetchFn} />)
    await user.click(idField())
    await user.paste(`${WIN}\n`)
    expect(idField().value).toBe(WIN)
  })
})

describe("Show this proof laid out", () => {
  it("lays the fetched proof out for reading, and the field keeps the exact text", async () => {
    window.location.hash = `#open=${WIN}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(exampleAnswers()).fetchFn} />)
    await user.click(lookUpButton())
    await waitFor(() => expect(document.querySelector("[data-status] p")?.textContent).toBe("PASS"))
    const shown = document.querySelector("[data-laid-out]")?.textContent ?? ""
    expect(shown).toBe(layOut(box().value))
    expect(shown.split("\n").length).toBeGreaterThan(20)
    expect(box().value).not.toContain("\n")
    // Without the added whitespace the laid-out text is the field's text, character for character.
    expect(withoutSpaceOutsideStrings(shown)).toBe(box().value)
  })
})

/** The text without the whitespace outside its strings. */
function withoutSpaceOutsideStrings(text: string): string {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") out += text[++i]
      else if (c === '"') inString = false
    } else if (!/\s/.test(c)) {
      out += c
      if (c === '"') inString = true
    }
  }
  return out
}
