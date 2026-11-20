import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { API_TOKEN, demoStepsFor, environmentFor, environments, policyFor } from "./environments"

/**
 * One build per environment (KAN-956). The table is pinned by its literals: a change of an address
 * a reader opens is a change of this test. Dev's list is under /verifier/dev/, where the mirror
 * serves the dev copy; prod's is at the mirror's root, where production will live (KAN-956).
 */
const ROOT = join(import.meta.dirname, "..")

describe("environments.json", () => {
  const list = environments()

  it("names dev and prod, each with its own API and its own list on the mirror", () => {
    expect(list).toEqual([
      { name: "dev", api: "https://public-api.dev.prizelayer.com", sums: "https://prizelayer.github.io/verifier/dev/SHA256SUMS" },
      { name: "prod", api: "https://play.prizelayer.com", sums: "https://prizelayer.github.io/verifier/SHA256SUMS" },
    ])
  })

  it.each([
    ["an API with a path", '{"dev":{"api":"https://a.example/x","sums":"https://b.example/SHA256SUMS"}}', /dev\.api must be a bare https origin/],
    ["an API over http", '{"dev":{"api":"http://a.example","sums":"https://b.example/SHA256SUMS"}}', /dev\.api must be a bare https origin/],
    ["an API with a trailing slash", '{"dev":{"api":"https://a.example/","sums":"https://b.example/SHA256SUMS"}}', /dev\.api must be a bare https origin/],
    ["a list that is not SHA256SUMS", '{"dev":{"api":"https://a.example","sums":"https://b.example/sums.txt"}}', /dev\.sums must be/],
    ["a name that is not lower-case letters", '{"Dev":{"api":"https://a.example","sums":"https://b.example/SHA256SUMS"}}', /'Dev' is not an environment name/],
    ["two environments on one API", '{"dev":{"api":"https://a.example","sums":"https://b.example/SHA256SUMS"},"prod":{"api":"https://a.example","sums":"https://b.example/SHA256SUMS"}}', /share one API/],
    ["no environment", "{}", /names no environment/],
  ])("refuses %s", (_name, text, error) => {
    expect(() => environments(text)).toThrow(error)
  })
})

describe("environmentFor", () => {
  const list = environments()

  it("gives a build the environment it names", () => {
    expect(environmentFor({ VERIFIER_ENV: "prod" }, true, list).api).toBe("https://play.prizelayer.com")
    expect(environmentFor({ VERIFIER_ENV: "dev" }, true, list).api).toBe("https://public-api.dev.prizelayer.com")
  })

  it("stops a build that names no environment, instead of building dev", () => {
    expect(() => environmentFor({}, true, list)).toThrow(/VERIFIER_ENV is not set/)
    expect(() => environmentFor({ VERIFIER_ENV: "" }, true, list)).toThrow(/VERIFIER_ENV is not set/)
  })

  it("stops on an environment the table does not have", () => {
    expect(() => environmentFor({ VERIFIER_ENV: "staging" }, true, list)).toThrow(/'staging' is not in environments\.json/)
  })

  it("gives the dev server and the tests dev when nothing is named", () => {
    expect(environmentFor({}, false, list).name).toBe("dev")
  })
})

describe("the page's own policy", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8")
  const [dev, prod] = environments()
  const apply = (source: string, environment = prod) => {
    const hook = policyFor(environment).transformIndexHtml as (h: string) => string
    return hook(source)
  }

  it("index.html holds the API token once and names no environment's API itself", () => {
    expect(html.split(API_TOKEN).length - 1).toBe(1)
    for (const environment of environments()) expect(html).not.toContain(environment.api)
  })

  it("is written with the build's own API and only that one", () => {
    const out = apply(html)
    expect(out).toContain(`connect-src ${prod.api};`)
    expect(out).not.toContain(dev.api)
    expect(out).not.toContain(API_TOKEN)
  })

  it.each([
    ["missing", "<html></html>", 0],
    ["twice", `${API_TOKEN} ${API_TOKEN}`, 2],
  ])("stops the build when the token is %s", (_name, source, count) => {
    expect(() => apply(source)).toThrow(`index.html holds ${API_TOKEN} ${count} times, not once`)
  })
})

/**
 * The dev list of the demo steps of 17 and 18 November 2026 (KAN-1751 plan v1.2 D3 A): the production build has
 * none, whatever the file says for dev, and a file that gives any other environment a list stops the build.
 */
describe("demo-steps.json", () => {
  const ID = "9c41d2e0-1a2b-4c3d-8e4f-5a6b7c8d9e01"
  const withSteps = (read: unknown) => JSON.stringify({ dev: { date: "2026-11-17", read, stepIds: [ID] } })

  it("gives the production build zero entries, from the file as committed and from a full list", () => {
    expect(demoStepsFor("prod")).toEqual([])
    expect(demoStepsFor("prod", withSteps("run 1"))).toEqual([])
    for (const environment of environments()) {
      if (environment.name !== "dev") expect(demoStepsFor(environment.name)).toEqual([])
    }
  })

  it("gives dev its list", () => {
    expect(demoStepsFor("dev", withSteps("run 1"))).toEqual([ID])
  })

  it("holds only a list for dev, dated by the day its demo rule started, 17 November 2026", () => {
    const file = JSON.parse(readFileSync(join(ROOT, "demo-steps.json"), "utf8"))
    expect(Object.keys(file)).toEqual(["dev"])
    expect(file.dev.date).toBe("2026-11-17")
  })

  it.each([
    ["a list for prod", JSON.stringify({ prod: { date: "2026-11-17", read: "r", stepIds: [] } }), /only dev has a list of demo steps, not 'prod'/],
    ["another date", JSON.stringify({ dev: { date: "2026-11-18", read: "r", stepIds: [] } }), /not '2026-11-18'/],
    ["an id in capitals", JSON.stringify({ dev: { date: "2026-11-17", read: "r", stepIds: [ID.toUpperCase()] } }), /lower case/],
    ["an id twice", JSON.stringify({ dev: { date: "2026-11-17", read: "r", stepIds: [ID, ID] } }), /listed twice/],
    ["steps with no read", withSteps(null), /names the read that made it/],
    ["steps with an empty read", withSteps(""), /names the read that made it/],
  ])("refuses %s", (_, text, message) => {
    expect(() => demoStepsFor("dev", text)).toThrow(message)
  })
})
