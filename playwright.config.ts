import { defineConfig, devices } from '@playwright/test';

/**
 * Three engines, three independent Web Crypto implementations. The point of the browser leg is
 * that the built artifact agrees with the Kotlin engine on somebody else's SHA-256, not only on
 * Node's — so running a single browser would defeat the exercise.
 */
export default defineConfig({
  testDir: './test',
  testMatch: /browser\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'list' : 'line',
  use: { baseURL: 'http://127.0.0.1:4173' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node test/browser/serve.mjs',
    url: 'http://127.0.0.1:4173/test/browser/index.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
