/**
 * "Verifies with our servers unreachable" is the claim that makes this a proof rather than a
 * courtesy, so it is asserted rather than described.
 *
 * Every network entry point a browser or Node build could reach is replaced with a throwing stub
 * before a full verification runs. If any future change reaches for the network — to fetch a prize
 * table, to "just check" a fingerprint against an API, to report telemetry — this suite fails
 * instead of quietly making the library dependent on us being online and honest.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { bytesFromHex, parseEdition, slotFor, verify } from '../src/verifier.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../fixtures/golden-vectors-v1.json', import.meta.url), 'utf8'),
);

const NETWORK_ENTRY_POINTS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;

describe('offline operation', () => {
  const saved = new Map<string, unknown>();

  before(() => {
    for (const name of NETWORK_ENTRY_POINTS) {
      saved.set(name, (globalThis as Record<string, unknown>)[name]);
      (globalThis as Record<string, unknown>)[name] = () => {
        throw new Error(`the verifier reached the network via ${name} — it must not`);
      };
    }
  });

  after(() => {
    for (const [name, original] of saved) {
      if (original === undefined) {
        delete (globalThis as Record<string, unknown>)[name];
      } else {
        (globalThis as Record<string, unknown>)[name] = original;
      }
    }
  });

  it('verifies a complete open with every network entry point poisoned', async () => {
    const vector = FIXTURE.editionFingerprint.vectors.find(
      (v: { id: string }) => v.id === 'canonical-unsorted-slots',
    );
    const edition = parseEdition({ ...vector.edition, slots: vector.edition.slotsAsGiven });

    const report = await verify({
      serverSeedHex: FIXTURE.draw.serverSeedHex,
      commitmentHex: FIXTURE.draw.commitmentHex,
      clientSeed: 'alice-seed',
      nonce: 1,
      edition,
      expected: {
        editionFingerprint: vector.editionFingerprint,
        drawnPpmValue: 186_669,
        drawnSlotIndex: slotFor(186_669, edition.slots),
      },
    });

    assert.equal(report.ok, true);
  });

  it('needs nothing but Web Crypto — the seed is data, not a fetch', async () => {
    // A sanity check on the shape of the dependency: bytesFromHex is pure, and the only global the
    // library touches is crypto.subtle. If that stops being true, the stubs above catch it.
    assert.equal(bytesFromHex(FIXTURE.draw.serverSeedHex).length, 32);
    assert.ok(globalThis.crypto?.subtle, 'Web Crypto must be present');
  });
});
