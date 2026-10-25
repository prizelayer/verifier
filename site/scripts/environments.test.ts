import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { API_TOKEN, environmentFor, environments, policyFor } from "./environments"

/**
 * One build per environment (KAN-956). The table is pinned by its literals: a change of an address
 * a reader opens is a change of this test. Dev's list stays at the mirror's root until its copy
 * moves to /verifier/dev/ (the owner's decision on KAN-956: the move and that value change
 * together, in the publish pull request).
 */
const ROOT = join(import.meta.dirname, "..")

describe("environments.json", () => {
  const list = environments()

  it("names dev and prod, each with its own API, and dev unchanged from the published page", () => {
    expect(list).toEqual([
      { name: "dev", api: "https://public-api.dev.prizelayer.com", sums: "https://prizelayer.github.io/verifier/SHA256SUMS" },
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
