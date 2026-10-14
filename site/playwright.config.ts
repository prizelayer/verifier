import { defineConfig, devices } from "@playwright/test"

/**
 * The built page, opened from disk, in three engines. No web server: the point is `file://`, the
 * copy a reader keeps and opens with every server of ours switched off.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "list" : "line",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
})
