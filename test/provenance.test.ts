/**
 * The vendored fixture must still be the one `fixtures/PROVENANCE.md` claims it is (KAN-29 S4).
 *
 * `prizelayer/platform` is private and this repository is public, so this build cannot fetch the
 * original to compare against — and deliberately must not try. `.github/workflows/ci.yml` promises
 * that the library is judged entirely against the committed fixture, with no network access to
 * PrizeLayer; a build that needed our servers would already have disproved the thing it exists to
 * prove. So the check here is hermetic: the copy must match the digest committed beside it.
 *
 * That pins one half of the drift problem — the copy and its provenance can only move in the same
 * reviewable commit. The other half (is that provenance still current?) needs to see both
 * repositories, so it runs on the platform side, on a schedule, outside the certified gate.
 * Neither half alone is enough; see ADR-KAN-38.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { hexFromBytes, sha256 } from '../src/verifier.js';

const FIXTURE_BYTES = new Uint8Array(
  readFileSync(new URL('../../fixtures/golden-vectors-v1.json', import.meta.url)),
);
const PROVENANCE = readFileSync(
  new URL('../../fixtures/PROVENANCE.md', import.meta.url),
  'utf8',
);

/**
 * Pull one value out of the provenance table, asserting the row exists and has the expected shape.
 *
 * Anchored on the row label and the table pipes, so prose elsewhere in the document that happens to
 * contain a hex string cannot be mistaken for the pin. Whitespace is tolerated everywhere a
 * markdown table may legally carry it: the platform-side mirror job parses this same file with its
 * own regex, and the two must not disagree about what counts as a row — a contributor aligning the
 * table columns should never look like a tampered pin. Backticks are optional because not every row
 * is code-formatted.
 */
function pinnedValue(label: string, pattern: string): string {
  const row = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*\`?(${pattern})\`?\\s*\\|`, 'm').exec(PROVENANCE);
  assert.ok(row, `fixtures/PROVENANCE.md has no '${label}' row matching /${pattern}/`);
  return row[1];
}

describe('the vendored fixture matches its provenance', () => {
  it('has the SHA-256 the provenance table pins', async () => {
    // Digested with the same one crypto path the library itself uses — node:crypto would be a
    // second implementation to audit, and the point of this file is that there is only one.
    const actual = hexFromBytes(await sha256(FIXTURE_BYTES));

    assert.equal(
      actual,
      pinnedValue('SHA-256', '[0-9a-f]{64}'),
      'fixtures/golden-vectors-v1.json and the SHA-256 in fixtures/PROVENANCE.md disagree. ' +
        'Either the fixture was edited here — which is never the correct fix for a failing ' +
        'vector — or it was updated from platform without re-pinning. Both must move together.',
    );
  });

  it('names a full source commit, not an abbreviation', () => {
    // The platform-side freshness check resolves this SHA against its own history. An abbreviated
    // one cannot be resolved reliably, and until KAN-38 this table pinned an abbreviated commit on
    // an unmerged branch — a pin naming something no reader could find. The assertion is inside
    // pinnedValue: a row that is missing, or carries fewer than 40 hex characters, fails there.
    pinnedValue('Source commit', '[0-9a-f]{40}');
  });

  it('pins the format version this library implements', () => {
    // formatVersion is the CRT-03 hook: a breaking change ships golden-vectors-v2.json beside the
    // v1 file rather than rewriting it, so every historical open stays verifiable under the rules
    // it was drawn under. This checks the PROVENANCE claim only — that the FIXTURE itself declares
    // version 1 is asserted by the 'fixture contract' suite in vectors.test.ts, and restating it
    // here would mean a v2 bump had to be edited in two places.
    assert.equal(pinnedValue('Format version', '\\d+'), '1');
  });
});
