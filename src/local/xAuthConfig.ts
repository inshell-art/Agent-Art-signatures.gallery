import { RealXOAuthClient, type XOAuthConfig } from "../claim/xOAuthClient.js";

export interface LocalAppConfig {
  port: number;
  appOrigin: string;
  authMode: "emulator" | "real";
  identityDailyCallLimit: number;
  oauth?: XOAuthConfig;
}

/** Validate before opening the database or changing Anvil's mining settings.
 * Credentials never implicitly select a provider and errors never echo values. */
export function loadLocalAppConfig(env: NodeJS.ProcessEnv, args: readonly string[] = []): LocalAppConfig {
  if (env.NODE_ENV === "production") throw new Error("Local rehearsal cannot run in production.");
  if (args.length > 1 || args.some(arg => !["--x-auth=real", "--x-auth=emulator"].includes(arg))) {
    throw new Error("Use --x-auth=real or --x-auth=emulator, at most once.");
  }
  const authMode = args[0]?.slice("--x-auth=".length) ?? env.LOCAL_X_AUTH_MODE ?? "emulator";
  if (authMode !== "emulator" && authMode !== "real") throw new Error("LOCAL_X_AUTH_MODE must be emulator or real.");
  const portRaw = env.LOCAL_APP_PORT ?? env.PORT ?? "3000";
  if (!/^[1-9]\d{0,4}$/.test(portRaw) || Number(portRaw) > 65_535) throw new Error("LOCAL_APP_PORT must be a valid TCP port.");
  const port = Number(portRaw);
  const appOrigin = `http://127.0.0.1:${port}`;
  if (env.APP_ORIGIN && env.APP_ORIGIN !== appOrigin) throw new Error(`APP_ORIGIN must be ${appOrigin} for this local app. Do not mix localhost and 127.0.0.1.`);
  const limitRaw = env.X_IDENTITY_DAILY_CALL_LIMIT ?? "100";
  if (!/^[1-9]\d{0,4}$/.test(limitRaw)) throw new Error("X_IDENTITY_DAILY_CALL_LIMIT must be an integer from 1 through 99999.");
  const config: LocalAppConfig = { port, appOrigin, authMode, identityDailyCallLimit: Number(limitRaw) };
  if (authMode === "emulator") return config;

  const required = ["X_OAUTH_CLIENT_ID", "X_OAUTH_CLIENT_SECRET"] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Real X sign-in requires ${missing.join(" and ")} in .env.local (OAuth 2.0 Web App credentials, not API keys). No simulator fallback.`);
  const redirectUri = `${appOrigin}/auth/x/callback`;
  if (env.X_OAUTH_REDIRECT_URI && env.X_OAUTH_REDIRECT_URI !== redirectUri) {
    throw new Error(`X_OAUTH_REDIRECT_URI must exactly match ${redirectUri}, also registered in the X developer app.`);
  }
  config.oauth = { clientId: env.X_OAUTH_CLIENT_ID!.trim(), clientSecret: env.X_OAUTH_CLIENT_SECRET!.trim(), redirectUri };
  return config;
}

export function localXOAuthClient(config: LocalAppConfig): RealXOAuthClient | undefined {
  if (config.authMode === "emulator") return undefined;
  if (!config.oauth) throw new Error("Real X authentication configuration is missing. No simulator fallback.");
  return new RealXOAuthClient(config.oauth);
}
