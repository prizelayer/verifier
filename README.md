# PrizeLayer verifier

**Check for yourself what you won.** This library recomputes a PrizeLayer draw from published data,
in your own browser, with no network access and no dependencies. It does not ask PrizeLayer whether
a draw was fair — it works the answer out from the same bytes the engine used.

The package is not published to npm. Build it from this repository; the result is one file,
`dist/verifier.js`, with no imports:

```
git clone https://github.com/prizelayer/verifier.git && cd verifier
npm ci && npm run build
```

- **Zero runtime dependencies.** Not "few". None. The only thing it uses is Web Crypto, which your
  browser and Node already ship.
- **Offline.** Given the inputs as data, it makes no network calls at all — asserted by a test that
  poisons every network entry point and then verifies anyway.
- **Built separately from the engine it checks.** That separation is the point; see below.

## Checking an open

The page is built from `site/` in this repository, once per environment, and each copy asks only its own environment's server. The dev copy is published at <https://d1c8hkgbfkzbx4.cloudfront.net/>, the address the dev player page's link opens, with a mirror on GitHub Pages at <https://prizelayer.github.io/verifier/dev/>. The production copy will live at the mirror's root, <https://prizelayer.github.io/verifier/>; until it does, that address shows a short page saying the production verifier is not live yet.

In your vault, every card and every History line has a link, "Check this open yourself". It opens this page with that open's id already filled in. Then press "Look up".

You never type a seed or a box here. "Look up" fetches the public records of that open from our server: the open, its seed pair, its box and its prize list. Your browser reads the secret, the client seed and the chances from those records, and redoes the pick itself. It sends our server nothing but the open's id and the ids our server gives back for it.

If the secret of this open is not revealed yet, the page shows "CANNOT CHECK YET" and says when it will be. Until then your browser checks the chances (step 2) and, when the proof has one, the prize list, but not the pick itself (steps 1 and 3, and the item in step 4).

## Why this is a separate repository

A `/verify` endpoint on PrizeLayer's own servers would be PrizeLayer marking its own homework. The
verification has to run somewhere they don't control. So this ships from its own public repository,
on its own build, with a permissive licence — and you can read all of it, in one file, without access
to anything else. That narrows what you have to trust; it does not remove PrizeLayer from it.
PrizeLayer wrote this code, so you still have to read it, or trust someone who did.

## What it checks

```ts
import { verify, parseEdition } from '@prizelayer/verifier';

const report = await verify({
  serverSeedHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  commitmentHex: '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
  clientSeed: 'alice-seed',
  nonce: 1,
  edition: parseEdition(publishedEdition),
  expected: {
    editionFingerprint: '290fa403670d94b94b80d580c0b86ab79e7628d98421b4ff76ebf2f031a17f44',
    drawnPpmValue: 186669,
    drawnSlotIndex: 0,
    snapshotHash: '19159c52d22eaba0ad100d31b5b8b643ddeb24620d761ca05ddf907c92e40617',
    itemId: '00112233-4455-6677-8899-aabbccddeeff',
  },
  snapshot: parseSnapshotBody(publishedSnapshotBody),
});

report.ok;          // true only if status is 'verified'
report.status;      // 'verified' | 'failed' | 'pending' | 'invalid'
report.firstFailure; // the first failing check, its step (1 to 4) and the input it names
report.notRun;      // every check that did not run, and why
report.summary;     // one line, safe to show a player
report.caveats;     // what this run did NOT prove — show these next to any pass
report.trace;       // every intermediate value, so you can check the workings by hand
```

`verify()` never throws. What it returns, with an example of each:

- **`verified`** — every check that ran passed, and the commitment, the odds, the draw and the
  slot all ran. Checks that did not run (no snapshot, no item id) are listed in `notRun`, and
  `caveats` says what that leaves unproven.
- **`failed`** — a check did not match, or an input it needed is unusable. Change one chance in the
  odds table from `250000` to `250001` and the table sums to 1,000,001: `editionFingerprint` fails
  with `error` explaining the sum and `field: 'edition'`, `firstFailure.step` is `2`, and the
  commitment and the draw are still recomputed and shown.
- **`pending`** — `serverSeedHex` is `null` because the seed pair has not retired yet, and every
  check that could run passed. The odds and the snapshot are checked; the commitment, the draw and
  the slot are in `notRun`; a commitment that is not 64 hex characters already fails here. If one
  of the checks that ran fails — odds that do not match their
  fingerprint, say — the status is `failed`, not `pending`.
- **`invalid`** — the input could not be read at all, so nothing was checked. `invalid.message`
  says why in plain words and names the input (`commitmentHex is missing or has the wrong type`);
  a missing `serverSeedHex` is `invalid`, because only `null` means "not revealed yet". When the
  refusal came from the runtime rather than from this library, its text is in `invalid.detail`. Use `verifyFrom(() => ({ ...parsed input... }))` to have refusals from `parseEdition`
  and `parseSnapshotBody` reported the same way.

Up to **seven** independent claims are checked, and every one of them must hold:

| Check | What a failure would mean |
|---|---|
| `commitment` | `SHA-256(revealed seed)` doesn't match the commitment published for this seed pair — the revealed seed is not the committed one. |
| `editionFingerprint` | The odds you were shown aren't the odds that were frozen when the box was published. |
| `drawnPpmValue` | The recorded random value isn't what the seed actually produces. |
| `drawnSlotIndex` | The value doesn't land on the slot you were given. |
| `snapshotHash` | The prize table you were shown isn't the one recorded against your win. |
| `snapshotEditionLink` | That prize table belongs to a **different** edition than the odds just verified, or it does not list exactly that edition's slots `0..n-1` (a slot left out, or one added; `expected` and `computed` are then the two slot lists). |
| `drawnItemId` | The item you were given isn't the item that table puts in the slot you drew, or the table has no entry for that slot. The second case fails even when no item id was given. |

The last three run only when you pass a `snapshot`. Leave it out and they are listed in
`report.notRun` — and `report.caveats` says, in plain language, that the item was never checked.
Pass a snapshot without `expected.itemId` and the snapshot is checked but the item is not compared;
that is reported the same way, never as a pass. A verifier that prints
green about a link it never looked at is worse than one that stays silent.

### The second check is the one that matters

It would be easy to write a verifier that skips it, and almost every "provably fair"
implementation does. Here's why that's worthless.

The draw turns three inputs into a number `v` between 0 and 999,999. To turn `v` into a prize you
need the odds table — which slot covers which range. If the verifier simply *accepts* the odds
table it's handed, then an operator can serve one table to the player and a different one to the
verifier, and the arithmetic checks out perfectly both times.

PrizeLayer's prize-table snapshot hash does **not** cover the probabilities. They exist in exactly
one place: the `edition_fingerprint` preimage, fixed when the box was published. So this library
rebuilds those canonical bytes itself and hashes them, then compares the result against the
fingerprint recorded on the win. If someone swapped the odds, the fingerprint won't match, and
`ok` is `false` no matter how honest the draw itself was.

### And the slot is a position, not a prize

Checking the draw and the odds shows that the revealed seed lands on *slot 2*, under odds that
match the fingerprint recorded on the win (5% for that slot). It says nothing about what was in slot 2.

That gap is real and it survives every check above. An operator can serve a draw and odds that pass
every check above, land you on a real slot — and then hand you a £20 voucher while reporting that
slot 2 was always a £20 voucher. Four green checks, one substituted prize.

Closing it is what the `0x03` snapshot preimage is for. It pins which item filled which slot at
which displayed value, and it **opens with the raw bytes of the edition fingerprint** — so a
snapshot is bound to one specific set of odds and cannot be lifted from another edition. A prize
list must list every slot of its box, `0..n-1`, and no other: a list with a slot left out or added
fails, even when its hash matches. Pass the
published snapshot to `verify()` and the chain runs all the way from the seed to the item recorded
for your win.

## The algorithms, in full

Nothing here is secret. You can implement it yourself and check this library too.

### 1. The commitment

For each seed pair the operator publishes `SHA-256(server_seed)`, the commitment. The seed stays
hidden until the seed pair retires. This library checks that the revealed seed hashes to the
commitment published for its seed pair. Because SHA-256 can't be reversed or collided in practice,
no other seed can match.

What it cannot check is *when* the commitment was published. A commitment locks the operator to a
seed only from the moment you saw it. If you were shown it before you played, the seed was fixed
before your play. If you were not, that ordering rests on the operator's own records, which this
library does not read.

### 2. The draw

```
derive(server_seed, client_seed, nonce) -> v in [0, 999999]:
    for attempt in 0, 1, 2, ...:
        h = HMAC-SHA256(key = server_seed,                    # the RAW 32 bytes, not the hex text
                        msg = ASCII(client_seed + ":" + nonce + ":" + attempt))
        for offset in 0, 4, 8, 12, 16, 20, 24, 28:            # in this order
            c = big_endian_uint32(h[offset .. offset+3])
            if c < 4_294_000_000:
                return c mod 1_000_000
        # all 8 chunks rejected -> next attempt
```

The threshold isn't arbitrary. 2³² isn't a multiple of 1,000,000, so a plain `mod` would make low
values slightly more likely — about 0.023% more. Discarding the short tail above 4,294,000,000
leaves a range that divides exactly, which makes the result uniform rather than nearly uniform. A
chunk is rejected roughly 1 time in 4,400; all eight failing at once has probability ≈6.6 × 10⁻³⁰,
which is specified anyway because an algorithm meant for certification has no undefined branch.

### 3. Mapping onto the prize table

Cumulative bounds in ascending `slotIndex` order: `cum_0 = p_0`, `cum_i = cum_{i-1} + p_i`. The
value `v` yields slot `i` where `cum_{i-1} <= v < cum_i`.

Strictly less-than. A `v` landing exactly on a bound belongs to the *next* slot, and a slot with
zero probability can never be selected. Both are pinned by golden vectors, because both are
invisible in `v` itself — an implementation can get every HMAC right and still hand you the wrong
prize.

### 3b. An upgrade step

A player who holds a win of an upgrade edition (engine type `single_draw_weighted_table_fair_upgrade`)
may stake it for the next strictly higher buy-back value of the same edition (ties: the lowest slot
index). The chance is `p = floor(1 000 000 × staked / target)` ppm, computed from the two values the
edition fingerprint binds; there is no offer below 100 000 ppm (10 %), from the top value, or past the
third step. The step draws one `v` on the player's next nonce, exactly as in section 2, and reads it
over the two-entry table `[p, 1 000 000 − p]` with the lookup of section 3: slot 0 is **won**, so a
step is won exactly when `v < p`. A won step makes a new win in the target slot; a lost step makes
nothing, and is verified the same way. `verifyUpgradeStep()` checks all of this from the published
step; `verify()` with `gameKind: 'upgrade'` checks an upgrade win over the step's table, never over
the box table.

### 4. The edition fingerprint

`SHA-256` over these bytes, in this exact order:

```
version    : 1 byte = 0x01
engineId   : 16 bytes, raw UUID, most-significant half first
engineVer  : u32, big-endian
priceCents : i64, big-endian, signed two's complement
slotCount  : u32, big-endian
per slot, in ASCENDING slotIndex order:
  slotIndex                 : u32 big-endian
  probabilityPpm            : u32 big-endian
  requiredBuyBackValueCents : i64 big-endian, signed
  requiredMarketValueCents  : i64 big-endian, signed
```

Fixed-width integers, no floats, no JSON, no text encoding of numbers — so there is exactly one
byte string for any given edition and no room for a formatting choice to change the hash. The
`slotCount` prefix means two editions with different slot counts can never collide.

Two fields you'll see on the published edition, `requiredBuyBackRateBps` and `requiredCategory`,
are **not** in this preimage. Hashing them produces a different, wrong fingerprint.

## Verifying the verifier

The numbers this library must reproduce aren't ours to choose. `fixtures/golden-vectors-v1.json` is
generated from PrizeLayer's certified Kotlin engine and committed unchanged; the test suite asserts
against it, and neither implementation is allowed to edit it to make itself pass. See
[`fixtures/PROVENANCE.md`](fixtures/PROVENANCE.md).

```bash
npm install
npm test           # Node: every vector, plus the offline guarantee
npm run test:browser   # Chromium, Firefox and WebKit — three independent Web Crypto stacks
```

The browser run matters more than it looks. Node and each browser ship their own SHA-256 and HMAC
implementations; "it passed in Node" says nothing about the engine your players actually use.

## API

| Export | |
|---|---|
| `verify(input)` | The whole check. Returns `{ ok, status, firstFailure, notRun, checks, trace, caveats, summary }`. Never throws. |
| `verifyFrom(build)` | `verify()`, with the parsing done inside `build` and its refusals reported as `invalid`. |
| `derive(seed, clientSeed, nonce)` | The derivation loop, with the full trace: every chunk of every attempt, and what the loop did with it. |
| `slotFor(v, slots)` | The cumulative lookup. Sorts by `slotIndex` itself. |
| `cumulativeTable(slots)` | The same lookup as a table: slot `i` owns every `v` with `from <= v < to`. |
| `CHECK_NAMES` / `STEP_OF` | The checks in reading order, and the step (1 to 4) each belongs to. |
| `editionBytes(edition)` | The canonical `0x01` preimage, for inspection. |
| `editionFingerprint(edition)` | `SHA-256` of the above, lowercase hex. |
| `commitment(seedBytes)` | `SHA-256` of the raw seed. |
| `parseEdition(json)` | Published JSON → typed edition, cents as `BigInt`. |
| `snapshotBytes(snapshot)` | The canonical `0x03` preimage, for inspection. |
| `snapshotHash(snapshot)` | `SHA-256` of the above — the `snapshot_hash` on the win. |
| `parseSnapshotBody(body)` | The published `snapshot.body` JSON (or its text) → typed snapshot. |
| `parseSnapshot(json)` | The camelCase, decimal-string form → typed snapshot. |
| `bytesFromHex` / `hexFromBytes` | Hex helpers. |
| `verifyUpgradeStep(input)` | One upgrade step, won or lost (section 3b). Returns an `UpgradeStepReport`, with its own check names (`UPGRADE_STEP_CHECK_NAMES`). Never throws. |
| `upgradeTarget(edition, slotIndex)` | The step a win in that slot is offered, `{ targetSlotIndex, chancePpm }`, or `null`. |
| `upgradeChancePpm(current, next)` | `floor(1 000 000 × current / next)`, exact in `BigInt`. |
| `stepTable(p)` / `stepOutcome(v, p)` | The step's two-entry table, and `won` or `lost` for `v` over it. |

Everything is `async`, because Web Crypto is. There's no synchronous variant on purpose: a second
code path would be a second thing to audit.

### One gotcha, if you're integrating

Cents are `bigint`, and published cents arrive as **decimal strings**. Signed 64-bit values exceed
`Number.MAX_SAFE_INTEGER`, so a bare JSON number would be rounded by `JSON.parse` before your code
ever ran — and no reviver can recover the lost digits afterwards. `parseEdition()` handles this and
throws loudly if it's handed a number that has already lost precision.

Two more, specific to the snapshot preimage:

**`displayedMedia` is length-prefixed in UTF-8 bytes.** It's the only variable-width field in
either preimage, and `String.length` gives you UTF-16 code units. They're equal for ASCII and
different for everything else, so this bug passes every ASCII test you'll write. `'café'` is 5
bytes and 4 code units; `'🎁'` is 4 bytes and 2 code units. Use `TextEncoder`.

**`displayed_value_cents` must be written as plain digits.** `parseSnapshotBody()` reads each
value from the body's text, so a value above 2^53 is not rounded. A value written with an exponent,
such as `9.007199254740993e15`, is not read as that integer, and the prize-list check then fails.
The platform always writes plain digits.

**`snapshot_hash` is taken over the canonical bytes, never over the body JSON.** So re-serialising
the body — different whitespace, different key order — does *not* change the hash, and a verifier
that hashes the bytes it received would wrongly reject an honest snapshot. Parse the body into
fields and rebuild the preimage, which is what `parseSnapshotBody()` is for.

## What it does not do yet

It verifies the draw, the odds behind it, the slot you landed on, and — given the published
snapshot — the item that filled it. The chain from seed to prize is complete.

What remains outside it is **provenance**, not cryptography: that the item really existed in stock
and really shipped to you. That is inventory and fulfilment, and no hash can settle it.

The `0x02` content preimage, which binds the whole item set to an edition, is also not implemented.
`0x03` alone closes the player-facing slot → item gap, so `0x02` waits for a story that needs it.

## Licence

Apache-2.0.
