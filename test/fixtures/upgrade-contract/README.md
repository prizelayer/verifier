# The upgrade-step contract files — a draft copy

These three files are copied unchanged from the PrizeLayer documentation repository,
`specs/upgrade-step/` (KAN-1154 PR-0, the contract of `GET /verify/upgrade-steps/{id}` and of the
upgrade mark on `GET /verify/opens/{winId}`), draft commit `1eff410155ff33ab53fb2a8244cfbf30cdf07642`, and `verify-open-upgrade-win.json` from documentation #591 head `dc4af8f9` (which added `stakedSlotIndex`).

They are a **draft**: PR-0 is not merged yet, and when it is, these files are copied again from its
merge commit. Their seeds, fingerprints and hashes are placeholders, so they prove nothing about a draw.
`test/upgrade-verify.test.ts` reads them only to check that the library's input fields carry the same
names as the published answers. Those names are the contract.
