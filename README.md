# PrizeLayer verifier

**Check for yourself what you won.** This library recomputes a PrizeLayer draw from published data,
in your own browser, with no network access and no dependencies. It does not ask PrizeLayer whether
a draw was fair — it works the answer out from the same bytes the engine used.

```
npm install @prizelayer/verifier
```

- **Zero runtime dependencies.** Not "few". None. The only thing it uses is Web Crypto, which your
  browser and Node already ship.
- **Offline.** Given the inputs as data, it makes no network calls at all — asserted by a test that
  poisons every network entry point and then verifies anyway.
- **Built separately from the engine it checks.** That separation is the point; see below.

## Why this is a separate repository

A `/verify` endpoint on PrizeLayer's own servers would be PrizeLayer marking its own homework. The
verification has to run somewhere they don't control, from code that isn't theirs to change at the
moment you're looking at it. So this ships from its own public repository, on its own build, with a
permissive licence — and you can read all of it, in one file, without access to anything else.

## What it proves

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
  },
});

report.ok;      // true only if every check below passed
report.summary; // one line, safe to show a player
report.trace;   // every intermediate value, so you can check the workings by hand
```

Four independent claims are checked, and **all four must hold**:

| Check | What a failure would mean |
|---|---|
| `commitment` | `SHA-256(revealed seed)` doesn't match the hash published *before* you played — the seed was chosen after the fact. |
| `editionFingerprint` | The odds you were shown aren't the odds that were frozen when the box was published. |
| `drawnPpmValue` | The recorded random value isn't what the seed actually produces. |
| `drawnSlotIndex` | The value doesn't land on the slot you were given. |

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

## The algorithms, in full

Nothing here is secret. You can implement it yourself and check this library too.

### 1. The commitment

Before you play, you're shown `SHA-256(server_seed)`. The seed stays hidden until the seed pair
retires. Because SHA-256 can't be reversed or collided in practice, the operator is locked into a
seed they chose before knowing anything about your play.

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
| `verify(input)` | The whole check. Returns `{ ok, checks, trace, summary }`. |
| `derive(seed, clientSeed, nonce)` | The derivation loop, with the full rejection trace. |
| `slotFor(v, slots)` | The cumulative lookup. Sorts by `slotIndex` itself. |
| `editionBytes(edition)` | The canonical `0x01` preimage, for inspection. |
| `editionFingerprint(edition)` | `SHA-256` of the above, lowercase hex. |
| `commitment(seedBytes)` | `SHA-256` of the raw seed. |
| `parseEdition(json)` | Published JSON → typed edition, cents as `BigInt`. |
| `bytesFromHex` / `hexFromBytes` | Hex helpers. |

Everything is `async`, because Web Crypto is. There's no synchronous variant on purpose: a second
code path would be a second thing to audit.

### One gotcha, if you're integrating

Cents are `bigint`, and published cents arrive as **decimal strings**. Signed 64-bit values exceed
`Number.MAX_SAFE_INTEGER`, so a bare JSON number would be rounded by `JSON.parse` before your code
ever ran — and no reviver can recover the lost digits afterwards. `parseEdition()` handles this and
throws loudly if it's handed a number that has already lost precision.

## What it does not do yet

It verifies the draw, the odds behind it, and the slot you landed on. It does **not** yet verify
which specific item occupied that slot — that binding lives in a different hash preimage
(`0x03`) which isn't covered here. That's tracked, not forgotten.

## Licence

Apache-2.0.
