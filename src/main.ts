/**
 * Local dev entrypoint. Wires the placeholder in-memory Store/AssetStore
 * (no database needed) and starts the HTTP API. OAuth claiming and
 * provenance verification stay off unless their env vars are set, since
 * both need real X app credentials.
 */

import { MemoryAssetStore } from "./assets/memoryAssetStore.js";
import { RealXOAuthClient, type XOAuthClient } from "./claim/xOAuthClient.js";
import { startServer, type AppOptions } from "./api/server.js";
import { MemoryStore } from "./store/memoryStore.js";
import { RealXApiClient, type XApiClient } from "./verification/xApiClient.js";

const PORT = Number(process.env.PORT ?? 3000);

const store = new MemoryStore();
const assetStore = new MemoryAssetStore();

const options: AppOptions = {};

if (process.env.X_CLIENT_ID && process.env.X_REDIRECT_URI) {
  const oauthClient: XOAuthClient = new RealXOAuthClient({
    clientId: process.env.X_CLIENT_ID,
    clientSecret: process.env.X_CLIENT_SECRET,
    redirectUri: process.env.X_REDIRECT_URI,
  });
  options.oauthClient = oauthClient;
} else {
  console.log("X_CLIENT_ID/X_REDIRECT_URI not set — /claim/start and /claim/callback will 501");
}

if (process.env.X_BEARER_TOKEN && process.env.AGENT_HANDLE) {
  const xApiClient: XApiClient = new RealXApiClient({ bearerToken: process.env.X_BEARER_TOKEN });
  options.xApiClient = xApiClient;
  options.agentHandle = process.env.AGENT_HANDLE;
} else {
  console.log("X_BEARER_TOKEN/AGENT_HANDLE not set — new instances will stay 'unverified'");
}

startServer(store, assetStore, PORT, options);
console.log(`signatures.gallery listening on http://localhost:${PORT}`);
console.log("Store and AssetStore are in-memory — data resets on restart (schema.sql/Store interface are the real data model).");
