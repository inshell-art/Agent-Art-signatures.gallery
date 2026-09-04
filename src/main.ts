import { startServer, type AppOptions } from "./api/server.js";
import { RealXOAuthClient } from "./claim/xOAuthClient.js";
import { MemoryArtifactStore } from "./v1/artifacts.js";
import { MemoryAuthState } from "./v1/authState.js";
import { seedDevelopmentFixtures } from "./v1/fixtures.js";
import { DEV_CARD_RENDERER_VERSION, DEV_RENDERER_VERSION, developmentFixtureRenderer, RendererRegistry } from "./v1/renderer.js";
import { MemorySignatureStore } from "./v1/store.js";

const port = Number(process.env.PORT ?? 3000);
const fixtureMode = process.env.DEV_FIXTURES !== "0" && process.env.NODE_ENV !== "production";
const activeRendererVersion = process.env.ACTIVE_RENDERER_VERSION ?? DEV_RENDERER_VERSION;

if (process.env.NODE_ENV === "production") {
  const required = ["APP_ORIGIN", "SESSION_SECRET", "DATABASE_URL", "X_OAUTH_CLIENT_ID", "X_OAUTH_REDIRECT_URI", "ARTIFACT_STORAGE_CONFIG", "RATE_LIMIT_STORE_CONFIG"] as const;
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) throw new Error(`Production startup refused: missing required configuration keys: ${missing.join(", ")}.`);
  if (!process.env.APP_ORIGIN?.startsWith("https://")) throw new Error("Production startup refused: APP_ORIGIN must use HTTPS.");
  if ((process.env.SESSION_SECRET?.length ?? 0) < 32) throw new Error("Production startup refused: SESSION_SECRET must contain at least 32 characters.");
  if (activeRendererVersion === DEV_RENDERER_VERSION) throw new Error("Production startup refused: an approved ACTIVE_RENDERER_VERSION is required.");
  throw new Error("Production startup refused: durable database, artifact, session, and rate-limit adapters are not installed yet.");
}

const options: AppOptions = {
  fixtureMode,
  activeRendererVersion,
  cardRendererVersion: process.env.CARD_RENDERER_VERSION ?? DEV_CARD_RENDERER_VERSION,
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
const renderers = new RendererRegistry([developmentFixtureRenderer]);
if (fixtureMode) {
  await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: options.cardRendererVersion ?? DEV_CARD_RENDERER_VERSION }, auth);
}
startServer({ store, artifacts, auth, renderers }, port, options);
console.log(`signatures.gallery V1 listening on http://localhost:${port}`);
if (fixtureMode) console.log("Development fixtures are enabled; no fixture record is production provenance.");
