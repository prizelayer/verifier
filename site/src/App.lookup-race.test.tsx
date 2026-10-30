import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { EXAMPLE_PROOF, EXAMPLE_TEXT } from "./example"
import { LOOKUP_TIMEOUT_MS } from "./lookup"
import { exampleAnswers, fakeServer } from "./test/fakeServer"
import { LOOKUP_WORDS } from "./words"

const WIN = EXAMPLE_PROOF.open.winId
const OTHER = "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"

afterEach(() => {
  cleanup()
  window.location.hash = ""
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const verdict = () => document.querySelector("[data-status] p")?.textContent ?? null
const box = () => screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement
const idField = () => screen.getByRole("textbox", { name: "Look up an open by its id" }) as HTMLInputElement
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement

/** The example server, with the first answer held back until `release` is called. */
function heldServer() {
  const server = fakeServer(exampleAnswers())
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  let first = true
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (first) {
      first = false
      await held
    }
    return server.fetchFn(url, init)
  }) as typeof fetch
  return { fetchFn, calls: server.calls, release: () => release() }
}

describe("a lookup in flight", () => {
  it("locks the id, the box and the box's buttons until it ends", async () => {
    window.location.hash = `#open=${WIN}`
    const server = heldServer()
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    await user.click(button("Look up"))
    expect(idField().readOnly).toBe(true)
    expect(box().readOnly).toBe(true)
    expect(button("Try the example").disabled).toBe(true)
    server.release()
    await waitFor(() => expect(verdict()).toBe("PASS"))
    expect(idField().readOnly).toBe(false)
    expect(box().readOnly).toBe(false)
  })

  it("shows Look up as inactive while it runs, and keeps it focusable (aria-disabled, not disabled)", async () => {
    window.location.hash = `#open=${WIN}`
    const server = heldServer()
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    await user.click(button("Look up"))
    const lookUp = button("Look up")
    expect(lookUp.getAttribute("aria-disabled")).toBe("true")
    expect(lookUp.disabled).toBe(false)
    expect(lookUp.className).toContain("aria-disabled:opacity-50")
    server.release()
    await waitFor(() => expect(verdict()).toBe("PASS"))
    expect(button("Look up").getAttribute("aria-disabled")).toBeNull()
  })

  // Two presses in one task both ran before React drew the busy state again: two lookups started.
  it.each([
    ["clicks on Look up", () => button("Look up").click()],
    ["Enters in the field", () => fireEvent.keyDown(idField(), { key: "Enter" })],
  ])("starts one lookup for two %s in one task", async (_, pressOnce) => {
    window.location.hash = `#open=${WIN}`
    const server = heldServer()
    render(<App fetchFn={server.fetchFn} />)
    act(() => {
      pressOnce()
      pressOnce()
    })
    server.release()
    await waitFor(() => expect(verdict()).toBe("PASS"))
    expect(server.calls.filter((call) => call.url.endsWith(`/verify/opens/${WIN}`))).toHaveLength(1)
  })

  // The reviewer's probe: look up A, put B in the field while A is in flight, let A arrive.
  it("drops a late answer when the id on screen is no longer the one looked up", async () => {
    window.location.hash = `#open=${WIN}`
    const server = heldServer()
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    await user.click(button("Look up"))
    fireEvent.change(idField(), { target: { value: OTHER } })
    server.release()
    await waitFor(() => expect(button("Look up").disabled).toBe(false))
    expect(box().value).toBe("")
    expect(verdict()).toBeNull()
    expect(screen.queryByRole("button", { name: "Save this proof" })).toBeNull()
  })

  it("drops a late answer when the box no longer holds what it held at the press", async () => {
    window.location.hash = `#open=${WIN}`
    const server = heldServer()
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    await user.click(button("Look up"))
    fireEvent.change(box(), { target: { value: EXAMPLE_TEXT } })
    server.release()
    await waitFor(() => expect(button("Look up").disabled).toBe(false))
    expect(box().value).toBe(EXAMPLE_TEXT)
    expect(screen.queryByText(LOOKUP_WORDS.found)).toBeNull()
    expect(screen.queryByRole("button", { name: "Save this proof" })).toBeNull()
  })

  it("refuses the address's id followed by a path, and asks nothing", async () => {
    window.location.hash = `#open=${WIN}/../../seed-pairs/x`
    const server = fakeServer(exampleAnswers())
    const user = userEvent.setup()
    render(<App fetchFn={server.fetchFn} />)
    await user.click(button("Look up"))
    expect(await screen.findByText(LOOKUP_WORDS.notAnId)).toBeTruthy()
    expect(server.calls).toEqual([])
  })

  it("says our server did not answer after the time limit, and the page is usable again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.location.hash = `#open=${WIN}`
    const silent = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })) as typeof fetch
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<App fetchFn={silent} />)
    await user.click(button("Look up"))
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS)
    expect(await screen.findByText(LOOKUP_WORDS.timedOut)).toBeTruthy()
    expect(button("Look up").disabled).toBe(false)
    expect(box().readOnly).toBe(false)
  })
})

describe("Save this proof", () => {
  it("writes the box's text byte for byte, named after the id looked up, with one click", async () => {
    // A prize list whose displayed value is above 2^53: rewriting the text would round it.
    const answers = exampleAnswers()
    const path = `/verify/snapshots/${EXAMPLE_PROOF.snapshot.snapshotHash}`
    const big = JSON.stringify(EXAMPLE_PROOF.snapshot).replace('"displayed_value_cents":2000', '"displayed_value_cents":12345678901234567891')
    expect(big).toContain("12345678901234567891")
    answers.set(path, { status: 200, body: big })
    window.location.hash = `#open=${WIN}`
    const user = userEvent.setup()
    render(<App fetchFn={fakeServer(answers).fetchFn} />)
    await user.click(button("Look up"))
    await screen.findByRole("button", { name: "Save this proof" })

    const blobs: Blob[] = []
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob)
      return "blob:proof"
    })
    URL.revokeObjectURL = vi.fn()
    const clicks: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this)
    })
    await user.click(button("Save this proof"))

    expect(blobs).toHaveLength(1)
    expect(await blobs[0].text()).toBe(box().value)
    expect(box().value).toContain("12345678901234567891")
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toBe(`proof-${WIN}.json`)
    expect(clicks[0].href).toBe("blob:proof")
  })
})
