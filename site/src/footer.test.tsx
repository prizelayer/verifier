import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { Footer, REPO_URL, SUMS_URL } from "./footer"
import { expectNoAxeViolations } from "./test/axe"
import { FOOTER } from "./words"

afterEach(cleanup)

const BUILD = { commit: "57d5f4c5a1b2c3d4e5f60718293a4b5c6d7e8f90", runId: "18012345678" }
const footer = () => screen.getByRole("contentinfo")
const hrefs = () => within(footer()).getAllByRole("link").map((a) => a.getAttribute("href"))

describe("the footer (where this copy comes from)", () => {
  it("names the commit and the run of the publish workflow, and links to the two records on GitHub", () => {
    render(<Footer build={BUILD} />)
    expect(footer().textContent).toContain(`${FOOTER.built} 57d5f4c5a1b2 ${FOOTER.ofRepo} prizelayer/verifier, ${FOOTER.byRun} 18012345678`)
    expect(hrefs()).toEqual([
      `${REPO_URL}/commit/${BUILD.commit}`,
      REPO_URL,
      SUMS_URL,
      `${REPO_URL}/actions/runs/18012345678`,
    ])
    expect(SUMS_URL).toBe("https://prizelayer.github.io/verifier/SHA256SUMS")
    expect(REPO_URL).toBe("https://github.com/prizelayer/verifier")
  })

  it("shows no fingerprint of the page itself, and says why", () => {
    render(<Footer build={BUILD} />)
    expect(footer().textContent).toContain(FOOTER.noSelfHash)
    // A 64-hex value would read as a fingerprint of the page; the commit is shown short.
    expect(footer().textContent).not.toMatch(/[0-9a-f]{40}/)
  })

  it("names no build and links only to the code when the copy was not built by the publish workflow", () => {
    render(<Footer build={null} />)
    expect(footer().textContent).toContain(FOOTER.notPublished)
    expect(footer().textContent).not.toContain("SHA256SUMS")
    expect(hrefs()).toEqual([REPO_URL])
  })

  it("is on the page, after the main content, and has no accessibility violation", async () => {
    const { container } = render(<App />)
    expect(container.lastElementChild?.tagName).toBe("FOOTER")
    await expectNoAxeViolations(container)
  })

  it("a test build names no build: only the publish workflow sets the two values", () => {
    render(<App />)
    expect(footer().textContent).toContain(FOOTER.notPublished)
  })
})
