/**
 * Each vendored fixture must still be the one `fixtures/PROVENANCE.md` claims it is (KAN-29 S4, KAN-1204).
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

const PROVENANCE = readFileSync(
  new URL('../../fixtures/PROVENANCE.md', import.meta.url),
  'utf8',
);

/** Each vendored fixture, by its path under fixtures/, as its table's `File` row names it (KAN-1204). */
const FIXTURES = ['golden-vectors-v1.json', 'volatility/cases-v1.json'];

function fixtureBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../fixtures/${file}`, import.meta.url)));
}

/**
 * The table of one fixture: the run of table lines around the `File` row that names it, exactly.
 * A pin is read from its own file's table only, so a second file can never borrow the first file's
 * digest. The platform's mirror job (tools/ci/fixture-provenance.sh) cuts the same block.
 */
function tableOf(file: string): string {
  const tables = PROVENANCE.split(/\n(?!\|)/).map((chunk) => chunk.split('\n').filter((l) => l.startsWith('|')));
  const named = tables.filter((lines) =>
    lines.some((l) => {
      const m = /^\|\s*File\s*\|\s*`?([^`|]+?)`?\s*\|/.exec(l);
      return m !== null && m[1] === file;
    }),
  );
  assert.equal(named.length, 1, `fixtures/PROVENANCE.md has ${named.length} tables whose File row names '${file}'`);
  return named[0].join('\n');
}

/**
 * Pull one value out of a fixture's provenance table, asserting the row exists and has the expected
 * shape.
 *
 * Anchored on the row label and the table pipes, so prose elsewhere in the document that happens to
 * contain a hex string cannot be mistaken for the pin. Whitespace is tolerated everywhere a
 * markdown table may legally carry it: the platform-side mirror job parses this same file with its
 * own regex, and the two must not disagree about what counts as a row — a contributor aligning the
 * table columns should never look like a tampered pin. Backticks are optional because not every row
 * is code-formatted.
 */
function pinnedValue(file: string, label: string, pattern: string): string {
  const row = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*\`?(${pattern})\`?\\s*\\|`, 'm').exec(tableOf(file));
  assert.ok(row, `the table of ${file} in fixtures/PROVENANCE.md has no '${label}' row matching /${pattern}/`);
  return row[1];
}

for (const file of FIXTURES) {
  describe(`the vendored fixture ${file} matches its provenance`, () => {
    it('has the SHA-256 its provenance table pins', async () => {
      // Digested with the same one crypto path the library itself uses — node:crypto would be a
      // second implementation to audit, and the point of this file is that there is only one.
      const actual = hexFromBytes(await sha256(fixtureBytes(file)));

      assert.equal(
        actual,
        pinnedValue(file, 'SHA-256', '[0-9a-f]{64}'),
        `fixtures/${file} and its SHA-256 in fixtures/PROVENANCE.md disagree. ` +
          'Either the fixture was edited here — which is never the correct fix for a failing ' +
          'vector — or it was updated from platform without re-pinning. Both must move together.',
      );
    });

    it('names a full source commit, not an abbreviation', () => {
      // The platform-side freshness check resolves this SHA against its own history. An abbreviated
      // one cannot be resolved reliably, and until KAN-38 this table pinned an abbreviated commit on
      // an unmerged branch — a pin naming something no reader could find. The assertion is inside
      // pinnedValue: a row that is missing, or carries fewer than 40 hex characters, fails there.
      pinnedValue(file, 'Source commit', '[0-9a-f]{40}');
    });

    it('pins the format version this library implements', () => {
      // formatVersion is the CRT-03 hook: a breaking change ships a v2 file beside the v1 file
      // rather than rewriting it, so every historical open stays verifiable under the rules it was
      // drawn under. This checks the PROVENANCE claim only — what the FIXTURE itself declares is
      // asserted by the suite that reads it, and restating it here would mean a v2 bump had to be
      // edited in two places.
      assert.equal(pinnedValue(file, 'Format version', '\\d+'), '1');
    });
  });
}

describe('the provenance tables', () => {
  it('give a second file none of the first file\'s pins', () => {
    assert.notEqual(
      pinnedValue('golden-vectors-v1.json', 'SHA-256', '[0-9a-f]{64}'),
      pinnedValue('volatility/cases-v1.json', 'SHA-256', '[0-9a-f]{64}'),
    );
    assert.throws(() => tableOf('cases-v1.json'), /has 0 tables/);
  });
});
