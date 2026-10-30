import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, normalize } from "node:path"
import { expect, test } from "@playwright/test"
import { environmentFor } from "../scripts/environments"

// The page inside a player's overlay: framed by another origin with the sandbox the player sets,
// `allow-scripts allow-same-origin` and nothing else. A form submit does nothing in such a frame
// (no `allow-forms`), so "Look up" must work without one. The proof is the one request a lookup
// tries, which the page makes only after the press. Two local servers give the two origins.
const DIST = join(import.meta.dirname, "..", "dist")
const ENVIRONMENT = environmentFor(process.env, true)
const WIN = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" }

function serve(handler: (path: string) => Promise<{ type: string; body: Buffer | string } | null>): Promise<Server> {
  const server = createServer(async (req, res) => {
    const found = await handler(new URL(req.url ?? "/", "http://x").pathname).catch(() => null)
    if (found === null) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { "content-type": found.type }).end(found.body)
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}
const origin = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`

let page: Server
let host: Server
test.beforeAll(async () => {
  page = await serve(async (path) => {
    const file = normalize(join(DIST, path === "/" ? "index.html" : path))
    if (!file.startsWith(DIST)) return null
    return { type: TYPES[extname(file)] ?? "application/octet-stream", body: await readFile(file) }
  })
  // The host page frames the page with the overlay's sandbox, as the player does.
  const frame = `<iframe sandbox="allow-scripts allow-same-origin" src="${origin(page)}/#open=${WIN}" style="width:900px;height:900px"></iframe>`
  host = await serve(async (path) => (path === "/" ? { type: "text/html", body: `<!doctype html><title>host</title>${frame}` } : null))
})
test.afterAll(() => {
  page.close()
  host.close()
})

test("Look up works in a frame sandboxed with allow-scripts allow-same-origin only", async ({ page: tab, context }) => {
  const winId = WIN
  const refused: string[] = []
  // Every request off this machine is refused; the two local origins are served.
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    refused.push(route.request().url())
    return route.abort()
  })
  const blocked: string[] = []
  tab.on("console", (m) => {
    if (/form submission|allow-forms/i.test(m.text())) blocked.push(m.text())
  })

  await tab.goto(`${origin(host)}/`)
  const framed = tab.frameLocator("iframe")
  await expect(framed.getByRole("textbox", { name: "Look up an open by its id" })).toHaveValue(winId)
  expect(refused).toEqual([])

  await framed.getByRole("button", { name: "Look up" }).click()

  await expect(framed.getByText("Your browser could not reach our server.")).toBeVisible()
  expect(refused).toEqual([`${ENVIRONMENT.api}/verify/opens/${winId}`])
  expect(blocked).toEqual([])
})

// Refs: KAN-1205
