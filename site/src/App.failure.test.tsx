import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { COULD_NOT_FINISH } from "./words"

// A check that throws, which checkProof is built never to do: the page must still answer and be
// usable again. Its own file, because the stand-in replaces checkProof for every test in the file.
vi.mock("./proof", async (original) => ({
  ...(await original<typeof import("./proof")>()),
  checkProof: () => Promise.reject(new RangeError("Maximum call stack size exceeded")),
}))

afterEach(cleanup)

describe("a check that stops on an unplanned error", () => {
  it("shows a plain sentence, and the box and the button work again", async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole("button", { name: "Try the example" }))

    expect(await screen.findByText(COULD_NOT_FINISH)).toBeTruthy()
    expect(screen.queryByText("Computing in your browser…")).toBeNull()
    await waitFor(() => expect(screen.getByRole("button", { name: "Check" }).hasAttribute("disabled")).toBe(false))
    expect((screen.getByRole("textbox", { name: "Paste a proof" }) as HTMLTextAreaElement).readOnly).toBe(false)
  })
})
