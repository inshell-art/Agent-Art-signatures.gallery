# signatures.gallery V1

A deterministic signature preview and claim service. V1 accepts a normalized X handle and a fixed-point `gr0k` value, renders a side-effect-free preview, authenticates the matching account through X OAuth, and creates an immutable claimed signature only after an explicit confirmation POST.

The current local build implements the V1 product flow with in-memory development fixtures:

- `GET|HEAD /s/{handle}/{gr0k}` — side-effect-free preview with canonical redirects.
- `GET /renders/{renderer_version}/{handle}/{gr0k}.{svg|png}` — versioned preview assets.
- `POST /auth/x/start` and `GET /auth/x/callback` — session-bound OAuth/PKCE flow.
- `GET /claim/review` and `POST /api/v1/signatures` — authenticated review and sole creation boundary.
- `GET /me` — private account collection.
- `GET /signatures/{signature_id}` and `/artifacts/{signature_id}.{svg|png}` — stable unlisted record and immutable assets.
- Legacy three-segment `/s`, `/c`, and `/v` routes return `410 Gone`.

## Local inspection

```bash
npm install
npm run dev
```

Open http://localhost:3000. Development fixtures are enabled by default. Use “My collection” → “Open fixture collection” to see three claimed signatures, or open `/s/alice/0.371924` and run the complete demo claim flow.

Run `npm test`, `npm run typecheck`, and `npm run build` before committing.

## Production blockers

The bundled `sg-renderer-dev-fixture` exists only so the product can be inspected locally. It is not the approved artistic renderer. Production startup rejects it. The project still requires:

- the approved `renderSignature(handle, gr0k)` implementation, immutable `sg-renderer-1.0.0` assets, and golden hashes;
- Postgres, content-addressed object storage, distributed session/flow and rate-limit adapters;
- production X OAuth credentials and live smoke testing;
- deployment/CDN purge integration and the operator erasure runbook.

No private Grok transcript, source Post, rationale, X token, wallet, or blockchain data is stored by V1.
