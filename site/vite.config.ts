import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

/**
 * One build for three places: the CloudFront host, the GitHub Pages host (under /verifier/), and a
 * copy opened from disk. So every path is relative, nothing is split into chunks, and the script is
 * one classic file: a browser refuses a module script on a page opened from `file://`.
 * `scripts/classic-script.mjs` turns Vite's module tag into a classic one after the build.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
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
})
