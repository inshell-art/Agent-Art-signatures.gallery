import { loadLocalAppConfig } from "./xAuthConfig.js";
import { X_IDENTITY_SCOPES } from "../claim/xOAuthClient.js";

// Configuration-only check: no database, chain, X request, or secret output.
try {
  const config = loadLocalAppConfig(process.env, ["--x-auth=real"]);
  console.log(JSON.stringify({
    configured: true,
    provider: "real X OAuth 2.0 / PKCE",
    appOrigin: config.appOrigin,
    callback: config.oauth!.redirectUri,
    scopes: X_IDENTITY_SCOPES,
    credentials: "present (not tested against X)",
    next: "npm run local:up, then npm run local:serve:x; sign in through the collection dot.",
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local X configuration is invalid.");
  process.exitCode = 1;
}
