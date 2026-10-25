# The verification page

A static page that checks one open in your own browser, with the library in `../src/verifier.ts`.
Paste a proof, or press "Try the example"; for those, nothing is sent anywhere. Or type an open's id
and press "Look up": only then does the page fetch that open's public data, with four plain GET
requests to the one host its own policy names: the public API of the environment the copy was built
for (`environments.json`; dev `https://public-api.dev.prizelayer.com`, prod
`https://play.prizelayer.com`), the `API_BASE` value of `src/lookup.ts`. The fetched data is put in the proof field unchanged,
and the check runs in your browser exactly as for a pasted proof. "Save this proof" downloads it as a
file, and "Show this proof laid out" shows it with line breaks added, for reading only.

```
npm ci
VERIFIER_ENV=dev npm run build   # dist/: one index.html, one script, one stylesheet, the fonts
```

`VERIFIER_ENV` (dev or prod) is required for a build: there is one build per environment, and a
build that names none stops. The dev server and `npm test` use dev.

Open `dist/index.html` straight from disk; it works without a server and without a network. The
same `dist/` is what any host serves.

Checks, all run in CI (`site` and `site-mutation-sentinel` in `../.github/workflows/ci.yml`):

- `npm test` — the page in jsdom: the example passes, a changed counter fails at step 3, an unreadable
  proof is "cannot check", no accessibility violations, no browser storage in the source.
- `npm run check-bundle` — the built page loads as a classic script with relative paths, its policy
  names only its own environment's API (`VERIFIER_ENV`), no other environment's API is anywhere in
  the bundle, the footer links its environment's list, the bundle names no origin outside a short list, uses no browser storage, and carries the "what this does not prove"
  words.
- `npm run test:offline` — the built page opened from `file://` in Chromium, Firefox and WebKit with
  every network request refused, reaching PASS on the example with no request tried; and a lookup
  that tries exactly one request, for the open, only after the button.
- `test/mutations/*.patch` — each breaks the page in a way that would mislead a reader; each must
  turn `npm test` red.
