# Automated local Anvil mint — September 20, 2026

**Result: passed.** The user explicitly requested the automated local Anvil test. This is fixture-to-chain integration evidence, not a successful live X/Grok assessment or a browser-wallet compatibility test.

## Isolation

- Separate app `http://127.0.0.1:3021` and owned Anvil RPC `http://127.0.0.1:18561`, chain ID 31337.
- Fresh ignored namespace under `.local/open-mint/anvil-auto-20260920.OzeYfb`; no existing chain reset or reused deployment.
- Started directly with `--fixture --local-chain`, without loading `.env.local`, and with X/Grok bearer/API credentials removed from the child environment.
- Saved assessment and X identity both explicitly report `development-fixture`; model is `development-fixture-v1`.
- All 11 existing real-pilot records have the same aggregate SHA-256 before and after: `1cf3f760d2d2a4d5fa1cfa1ccab728d35cf30b861730cb0021869516acd0a8b3`.
- No paid X/Grok request, user-wallet interaction or real-value transfer was made.

## Execution

Contract build and all three renderer/slogan locks passed. Executed the existing harness:

```sh
OPEN_MINT_TEST_ORIGIN=http://127.0.0.1:3021 \
  node scripts/open-mint-rehearsal.mjs --execute-local-test-transactions
```

All 11 harness checks passed: editable preview bridge, forged MBTI rejection, wallet proof before assessment, private mint request, result withheld before confirmation, explicit consent, actual local mint, duplicate rejection before another assessment, wallet collection, native MBTI renderer, and immutable SVG/PNG hashes.

## Independently verified chain evidence

| Field | Observed value |
| --- | --- |
| Handle / fixture MBTI | `check_7d291b` / `ISFP` |
| Renderer | `sg-renderer-2.0.0` (the `2.0.1` patch is slogan-only) |
| Transaction | `0x6041abf6ee0e58a4aa56f5341e787051ca4e0618b74f33945ed10cb5c5e2ba65` |
| Receipt / block | `success` / `18` |
| Gas used | `390084` local test gas |
| Transaction value | `0` |
| Owner | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` (public Foundry test account) |
| Token ID | `58806082385620289490163778856062625945770508386298309498235731175898474935141` |

Direct read-only RPC checks independently verified chain ID, successful receipt, zero transaction value, `ownerOf`, and a nonempty `tokenURI`. The harness verified reveal, collection membership, and served asset bytes against their saved hashes. Test state is retained locally for inspection; the dedicated server was gracefully shut down after verification.

The live pilot remains a separate blocker: its approved recovery received X HTTP 402 before any Grok dispatch or mint. This local pass does not clear or retry that attempt.

## Repeat after wallet/provider changes

At 08:55 UTC, repeated the same 11-check harness against another new fixture namespace, `.local/open-mint/fixture-ci-check.oDYO3U`, using ports 3021/18561 only after verifying they were free. Paid credentials were removed and `.env.local` was not loaded. **All 11 checks passed again.**

- Handle / sample MBTI: `check_f4197c` / `ENTJ`.
- Transaction: `0x7347624c8bfc223aa3f010e0ae8cd27d4615dbb848146b9f6f87d19cfb6414a1`.
- Token: `30636333628141171603453082724152240468845058330916084966323704417466894655103`.
- Direct receipt read: status `0x1`, block `0x15` (21), gas `0x5f3c4` (390084), public test minter `0x976ea74026e726554db657fa54763abd0c3a0aa9`.

The verified test-owned app process was gracefully stopped, which closed its Anvil child. Its ignored state remains available. The real pilot on 3020/18560 was not restarted or reset. The repeat is an API/contract regression, not a claim that a real browser extension or live Grok was tested.
