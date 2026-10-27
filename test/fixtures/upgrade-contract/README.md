# The upgrade-step contract files

These three files are copied unchanged from the PrizeLayer documentation repository,
`specs/upgrade-step/` (KAN-1154 PR-0: the contract of `GET /verify/upgrade-steps/{id}` and of the
upgrade mark on `GET /verify/opens/{winId}`), at the merge commit of documentation #591,
`ede0acc06bfbb1d31721e64628e3298a9a60fa97`.

Their seeds, fingerprints and hashes are placeholders, so they prove nothing about a draw.
`test/upgrade-verify.test.ts` reads them only to check that the library's input fields carry the same
names as the published answers. Those names are the contract.
