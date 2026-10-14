import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "@playwright/test"

// The built page, from a file on disk, with the network refused: the example must reach PASS, and
// the page must ask the network for nothing. The subject is every http(s) or ws(s) request the
// browser tried, caught by the route below in all three engines; it must be an empty list. The page
// events are printed as well, but they are not the proof: Firefox reports no event for a file://
// load, so a list of them is not complete in every engine.
const PAGE = join(import.meta.dirname, "..", "dist", "index.html")

test("the page checks the example from file:// with the network refused", async ({ page, context }) => {
  expect(existsSync(PAGE), `${PAGE} does not exist: run npm run build first`).toBe(true)

  const requests: string[] = []
  page.on("request", (request) => requests.push(request.url()))
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
  const refused: string[] = []
  await context.route(/^(https?|wss?):/, (route) => {
    refused.push(route.request().url())
    return route.abort()
  })

  await page.goto(pathToFileURL(PAGE).href)
  await page.getByRole("button", { name: "Try the example" }).click()

  await expect(page.getByRole("status")).toContainText("PASS")
  console.log(`network requests refused (${refused.length}): ${refused.join(", ") || "none"}`)
  console.log(`page requests reported (${requests.length}):\n${requests.join("\n")}`)
  expect(refused).toEqual([])
  expect(requests.filter((url) => !url.startsWith("file://"))).toEqual([])
  expect(errors).toEqual([])
})

// The control for the test above: an empty `refused` list proves nothing unless the route really
// catches a request in this engine. Here one is made on purpose, and it must be caught.
test("the route catches a network request in this engine", async ({ page, context }) => {
  const refused: string[] = []
  await context.route(/^(https?|wss?):/, (route) => {
    refused.push(route.request().url())
    return route.abort()
  })
  await page.goto("https://example.org/").catch(() => undefined)
  expect(refused).toEqual(["https://example.org/"])
})

// A lookup is the one moment the page asks a server, and only after the button. With the network
// refused, the page must say it could not reach us, and the only request tried is the open's own.
test("a lookup from file:// asks only for the open, and only after the button", async ({ page, context }) => {
  const winId = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
  const refused: string[] = []
  await context.route(/^(https?|wss?):/, (route) => {
    refused.push(route.request().url())
    return route.abort()
  })

  await page.goto(`${pathToFileURL(PAGE).href}#open=${winId}`)
  await expect(page.getByRole("textbox", { name: "Look up an open by its id" })).toHaveValue(winId)
  expect(refused).toEqual([])
  await page.getByRole("button", { name: "Look up" }).click()

  await expect(page.getByText("Your browser could not reach our server.")).toBeVisible()
  console.log(`network requests refused (${refused.length}): ${refused.join(", ") || "none"}`)
  expect(refused).toEqual([`https://public-api.dev.prizelayer.com/verify/opens/${winId}`])
})
