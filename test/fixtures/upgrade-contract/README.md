# The upgrade-step contract files

These three files are copied unchanged from the PrizeLayer documentation repository,
`specs/upgrade-step/` (KAN-1154 PR-0: the contract of `GET /verify/upgrade-steps/{id}` and of the
upgrade mark on `GET /verify/opens/{winId}`), at documentation main
`1a507e527fedc3a5c9c1ff418ace89f254a1da97`. That copy adds `chanceCompact` (§6) and
`stepChanceCompact` (§7), the server's own floored percent, to the copy of #591 (`ede0acc0`).

Their seeds, fingerprints and hashes are placeholders, so they prove nothing about a draw.
`test/upgrade-verify.test.ts` reads them only to check that the library's input fields carry the same
names as the published answers. Those names are the contract.
