# The verification page

A static page that checks one open in your own browser, with the library in `../src/verifier.ts`.
Paste a proof, or press "Try the example". Nothing is sent anywhere: the page's own policy is
`connect-src 'none'`.

```
npm ci
npm run build      # dist/: one index.html, one script, one stylesheet, the fonts
```

Open `dist/index.html` straight from disk; it works without a server and without a network. The
same `dist/` is what any host serves.

Checks, all run in CI (`site` and `site-mutation-sentinel` in `../.github/workflows/ci.yml`):

- `npm test` — the page in jsdom: the example passes, a changed counter fails at step 3, an unreadable
  proof is "cannot check", no accessibility violations, no browser storage in the source.
- `npm run check-bundle` — the built page loads as a classic script with relative paths, names no
  origin outside a short list, uses no browser storage, and carries the "what this does not prove"
  words.
- `npm run test:offline` — the built page opened from `file://` in Chromium, Firefox and WebKit with
  every network request refused, reaching PASS on the example.
- `test/mutations/*.patch` — each breaks the page in a way that would mislead a reader; each must
  turn `npm test` red.
