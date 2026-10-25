import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"
import { buildInfoFrom } from "./scripts/build-info.ts"
import { environmentFor, type Environment } from "./scripts/environments.ts"

/** The one place in index.html where the environment's API goes: its policy's connect-src. */
export const API_TOKEN = "%VERIFIER_API%"

/**
 * Writes the environment's API into the page's own policy. The token must be in index.html exactly
 * once and must not survive, so a page can never ship with no API, or with a second one.
 */
export function policyFor(environment: Environment): Plugin {
  return {
    name: "verifier-policy",
    transformIndexHtml(html) {
      const count = html.split(API_TOKEN).length - 1
      if (count !== 1) throw new Error(`index.html holds ${API_TOKEN} ${count} times, not once`)
      return html.replace(API_TOKEN, environment.api)
    },
  }
}

/**
 * One build for three places: the CloudFront host, the GitHub Pages host (under /verifier/), and a
 * copy opened from disk. So every path is relative, nothing is split into chunks, and the script is
 * one classic file: a browser refuses a module script on a page opened from `file://`.
 * `scripts/classic-script.mjs` turns Vite's module tag into a classic one after the build.
 *
 * And one such build per environment (KAN-956): `VERIFIER_ENV` names it, and `environments.json`
 * gives its public API (the script's one host and the policy's connect-src) and its footer's list.
 */
export default defineConfig(({ command }) => {
  const environment = environmentFor(process.env, command === "build")
  return {
    base: "./",
    define: {
      // The footer names the build that made this copy (see scripts/build-info.ts); null for any
      // build that is not the publish workflow's.
      __VERIFIER_BUILD__: JSON.stringify(buildInfoFrom(process.env)),
      __VERIFIER_API__: JSON.stringify(environment.api),
      __VERIFIER_SUMS_URL__: JSON.stringify(environment.sums),
    },
    plugins: [react(), tailwindcss(), policyFor(environment)],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        // The library is imported from its source, so the page and the published library are one
        // implementation of the maths, not two.
        "@verifier": path.resolve(import.meta.dirname, "../src/verifier.ts"),
      },
    },
    server: { fs: { allow: [".."] } },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      assetsInlineLimit: 0,
      modulePreload: false,
      // One stylesheet file. Left to itself an iife build injects the CSS from the script, which a
      // policy without 'unsafe-inline' styles refuses.
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          format: "iife",
          entryFileNames: "assets/app-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    },
  }
})
