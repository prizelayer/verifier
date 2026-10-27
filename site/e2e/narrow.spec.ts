import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "@playwright/test"

// The built page on the narrowest phone we design for. After the example reaches PASS, with every section
// opened so no table hides, nothing on the page may be wider than the screen: a table too wide scrolls in a
// frame of its own. The subject is the document's own widths, read in all three engines.
const PAGE = join(import.meta.dirname, "..", "dist", "index.html")

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
