import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "@playwright/test"
import { environmentFor } from "../scripts/environments"

// The built page on the narrowest phone we design for. After the example reaches PASS, with every section
// opened so no table hides, nothing on the page may be wider than the screen: a table too wide scrolls in a
// frame of its own. The subject is the document's own widths, read in all three engines.
const PAGE = join(import.meta.dirname, "..", "dist", "index.html")
// The environment the page in dist/ was built for (KAN-956): the API a lookup asks.
const ENVIRONMENT = environmentFor(process.env, true)

test.use({ viewport: { width: 320, height: 640 } })

test("at 320 x 640 the checked example is no wider than the screen, and the step-3 table scrolls in its own frame", async ({
  page,
  context,
}) => {
  expect(existsSync(PAGE), `${PAGE} does not exist: run npm run build first`).toBe(true)
  await context.route(/^(https?|wss?):/, (route) => route.abort())
  await page.goto(pathToFileURL(PAGE).href)
  await page.getByRole("button", { name: "Try the example" }).click()
  await expect(page.getByRole("status")).toContainText("PASS")
  await page.$$eval("details", (all) => all.forEach((details) => (details.open = true)))

  const widths = await page.locator("html").evaluate((html) => ({ scroll: html.scrollWidth, client: html.clientWidth }))
  expect(widths.scroll, `the page is ${widths.scroll - widths.client} px wider than the screen`).toBe(widths.client)

  // The step-3 table: in a frame that can be reached by keyboard, and wider than the frame at this width,
  // so the frame really scrolls (the page above proved it does not push the page). Its number cells keep
  // their one line: there is at least one, so the frame is not passing for a table that lost them.
  const frame = page.getByRole("region", { name: "The 4-byte numbers" })
  await expect(frame).toHaveAttribute("tabindex", "0")
  await expect(frame.getByRole("table")).toBeVisible()
  expect(await frame.locator("td.whitespace-nowrap").count()).toBeGreaterThan(0)
  const frameWidths = await frame.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(frameWidths.scroll, "the step-3 table fits at 320 px, so its frame proves nothing").toBeGreaterThan(frameWidths.client)
})

// The same width with step 3's sentence about our record of the pair (KAN-935 PR-4): it shows only for a
// proof that "Look up" fetched, so the example's own answers are served for the lookup's four requests,
// with the record (shown and set) added to the seed pair. Every other request is refused.
test("at 320 x 640 a lookup whose client seed the player set is no wider than the screen", async ({ page, context }) => {
  expect(existsSync(PAGE), `${PAGE} does not exist: run npm run build first`).toBe(true)
  await context.route(/^(https?|wss?):/, (route) => route.abort())
  await page.goto(pathToFileURL(PAGE).href)
  await page.getByRole("button", { name: "Try the example" }).click()
  await expect(page.getByRole("status")).toContainText("PASS")
  const proof = JSON.parse(await page.getByRole("textbox", { name: "Paste a proof" }).inputValue())
  const record = {
    shownBeforeFirstOpen: true,
    clientSeedSetByPlayer: true,
    setEventRecordHash: "5c0e2b7a9d14f3e8c6a1b0d2e4f6a8c0b1d3e5f7a9c2e4f6b8d0a1c3e5f7a9b2",
  }
  const answers: Record<string, unknown> = {
    [`/verify/opens/${proof.open.winId}`]: proof.open,
    [`/verify/seed-pairs/${proof.seedPair.seedPairId}`]: { ...proof.seedPair, ...record },
    [`/verify/editions/${proof.edition.editionId}`]: proof.edition,
    [`/verify/snapshots/${proof.snapshot.snapshotHash}`]: proof.snapshot,
  }
  const served: string[] = []
  await context.unrouteAll()
  await context.route(/^(https?|wss?):/, (route) => {
    const url = route.request().url()
    const body = url.startsWith(ENVIRONMENT.api) ? answers[url.slice(ENVIRONMENT.api.length)] : undefined
    if (body === undefined) return route.abort()
    served.push(url)
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) })
  })
  await page.goto(`${pathToFileURL(PAGE).href}#open=${proof.open.winId}`)
  await page.reload()
  await page.getByRole("button", { name: "Look up" }).click()
  await expect(page.getByRole("status")).toContainText("PASS")
  expect(served).toHaveLength(4)
  // Step 3 has the sentence; step 1 has none, even though the record says the pair was shown.
  await expect(page.locator('[data-step="3"] [data-pair-record]')).toContainText("Our records say you set this pair's client seed")
  await expect(page.locator("[data-pair-record]")).toHaveCount(1)
  await page.$$eval("details", (all) => all.forEach((details) => (details.open = true)))

  const widths = await page.locator("html").evaluate((html) => ({ scroll: html.scrollWidth, client: html.clientWidth }))
  expect(widths.scroll, `the page is ${widths.scroll - widths.client} px wider than the screen`).toBe(widths.client)
})
