import { startServer, type AppOptions } from "./api/server.js";
import { RealXOAuthClient } from "./claim/xOAuthClient.js";
import { MemoryArtifactStore } from "./v1/artifacts.js";
import { MemoryAuthState } from "./v1/authState.js";
import { seedDevelopmentFixtures } from "./v1/fixtures.js";
import { CARD_RENDERER_VERSION, RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "./v1/renderer.js";
import { MemorySignatureStore } from "./v1/store.js";
import { loadMintConfig } from "./v2/config.js";
import { seedV2DevelopmentFixtures } from "./v2/fixtures.js";
import { seedGalleryDevelopmentFixtures } from "./v2/galleryFixtures.js";
import { MemoryMintStore } from "./v2/memoryStore.js";
import { V2MintService } from "./v2/service.js";

const port = Number(process.env.PORT ?? 3000);
const fixtureMode = process.env.DEV_FIXTURES !== "0" && process.env.NODE_ENV !== "production";
const activeRendererVersion = process.env.ACTIVE_RENDERER_VERSION ?? RENDERER_VERSION;

if (process.env.NODE_ENV === "production") {
  const required = ["APP_ORIGIN", "SESSION_SECRET", "DATABASE_URL", "X_OAUTH_CLIENT_ID", "X_OAUTH_REDIRECT_URI", "ARTIFACT_STORAGE_CONFIG", "RATE_LIMIT_STORE_CONFIG"] as const;
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) throw new Error(`Production startup refused: missing required configuration keys: ${missing.join(", ")}.`);
  if (!process.env.APP_ORIGIN?.startsWith("https://")) throw new Error("Production startup refused: APP_ORIGIN must use HTTPS.");
  if ((process.env.SESSION_SECRET?.length ?? 0) < 32) throw new Error("Production startup refused: SESSION_SECRET must contain at least 32 characters.");
  if (activeRendererVersion !== RENDERER_VERSION || !formalSignatureRenderer.approved) throw new Error("Production startup refused: an approved ACTIVE_RENDERER_VERSION is required.");
  throw new Error("Production startup refused: durable database, artifact, session, and rate-limit adapters are not installed yet.");
}

const options: AppOptions = {
  fixtureMode,
  activeRendererVersion,
  cardRendererVersion: process.env.CARD_RENDERER_VERSION ?? CARD_RENDERER_VERSION,
  publicOrigin: process.env.APP_ORIGIN ?? `http://localhost:${port}`,
  identityDailyCallLimit: Number(process.env.X_IDENTITY_DAILY_CALL_LIMIT ?? 500),
};

const oauthClientId = process.env.X_OAUTH_CLIENT_ID ?? process.env.X_CLIENT_ID;
const oauthRedirectUri = process.env.X_OAUTH_REDIRECT_URI ?? process.env.X_REDIRECT_URI;
const oauthClientSecret = process.env.X_OAUTH_CLIENT_SECRET ?? process.env.X_CLIENT_SECRET;
if (oauthClientId && oauthRedirectUri) {
  options.oauthClient = new RealXOAuthClient({
    clientId: oauthClientId,
    clientSecret: oauthClientSecret,
    redirectUri: oauthRedirectUri,
  });
}

const store = new MemorySignatureStore();
const artifacts = new MemoryArtifactStore();
const auth = new MemoryAuthState();
const renderers = new RendererRegistry([formalSignatureRenderer]);
if (fixtureMode) {
  await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: options.cardRendererVersion ?? CARD_RENDERER_VERSION }, auth);
}
const mintConfig = loadMintConfig(process.env, fixtureMode, options.publicOrigin ?? `http://localhost:${port}`);
const mintState = new MemoryMintStore();
const mint = new V2MintService(mintConfig, mintState, store, artifacts);
if (fixtureMode && mintConfig.enabled) {
  await seedV2DevelopmentFixtures(mint, store);
  await seedGalleryDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: options.cardRendererVersion ?? CARD_RENDERER_VERSION }, auth, mint);
}
startServer({ store, artifacts, auth, renderers, mint }, port, options);
console.log(`signatures.gallery V2 listening on http://localhost:${port}`);
if (fixtureMode) console.log("Development rehearsal fixtures are enabled; seeded identity, wallet, transaction, and finality records are not production provenance.");
