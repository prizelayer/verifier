# The upgrade-step contract files

These three files are copied unchanged from the PrizeLayer documentation repository,
`specs/upgrade-step/` (KAN-1154 PR-0: the contract of `GET /verify/upgrade-steps/{id}` and of the
upgrade mark on `GET /verify/opens/{winId}`), at documentation main
`1a507e527fedc3a5c9c1ff418ace89f254a1da97`. That copy adds `chanceCompact` (§6) and
`stepChanceCompact` (§7), the server's own floored percent, to the copy of #591 (`ede0acc0`).

Their seeds, fingerprints and hashes are placeholders, so they prove nothing about a draw.
`test/upgrade-verify.test.ts` reads them only to check that the library's input fields carry the same
names as the published answers. Those names are the contract.

`console-edition-check-upgrade-v3.json` and `console-edition-check-upgrade-v3-below-floor.json` are
copied unchanged from the same folder at documentation main `3f7e85964c2432a2d5787025627e926f0f24af3d` (KAN-1751, documentation #968:
the console's edition check on version 3). They are the answers for the worked box of ADR-KAN-1154
amendment 8 §8.3 (9 636 bps) and for the draft at 91.98 % (§8.6). `test/upgrade-v3.test.ts` checks
that this library computes the same step rate and the same single offers for those two boxes on its
own, and refuses the box under the floor as the console check does.

`verify-upgrade-step-won-v4.json`, `verify-upgrade-step-v4-no-amount.json`, `verify-open-upgrade-win-v4.json` and
`verify-open-upgrade-win-v4-no-amount.json` are copied unchanged from the same folder at documentation commit
`99cd89d6` (KAN-1569 P7, documentation draft pull request #1108; re-pinned to its merge commit on main before this
pull request is ready). They are Ana's step on box C of ADR-KAN-1154 amendment 9 §9.8 with 21.28 EUR recorded
(`boostCents` and `stepBoostCents` the decimal string `"2128"`, 288 016 ppm; cto ruling KAN-1569 37069) and the same step with no amount (188 000 ppm, no amount
key), and the wins they made. Their ids, fingerprints and hashes are placeholders; their draws are the fixture
seed's own. `test/upgrade-v4.test.ts` checks that each verifies on box C, and that the amount is a decimal string
of cents with one and has no key without one.
