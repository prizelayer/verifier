import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { EXAMPLE_PROOF } from "./example"
import { LOOKUP_WORDS } from "./words"

// lookUp returns every fault of the network and of our server as a result; only an error of the page itself
// reaches the press's catch. Here lookUp throws one, as a bug in the page would.
vi.mock("./lookup", async (original) => ({
  ...(await original<typeof import("./lookup")>()),
  lookUp: vi.fn(async () => {
    throw new TypeError("a bug in the page")
  }),
}))

afterEach(() => {
  cleanup()
  window.location.hash = ""
  vi.restoreAllMocks()
})

describe("a lookup that fails in the page", () => {
  it("says the page could not finish, does not blame our server, and keeps the error in the console", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    window.location.hash = `#open=${EXAMPLE_PROOF.open.winId}`
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Look up" }))

    expect(await screen.findByText(LOOKUP_WORDS.pageFault)).toBeTruthy()
    expect(document.querySelector("main")?.textContent).not.toContain("Our server sent a faulty answer")
    expect(logged).toHaveBeenCalledWith("lookup failed in the page", expect.any(TypeError))
    // The page is usable again: the button is no longer busy.
    await waitFor(() => expect(screen.getByRole("button", { name: "Look up" }).getAttribute("aria-disabled")).toBeNull())
  })
})
