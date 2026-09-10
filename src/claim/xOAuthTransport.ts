import { EnvHttpProxyAgent } from "undici";

/** Per-client dispatcher only: never proxy Anvil or change global fetch routing.
 * Node 22.16's built-in fetch does not use HTTP(S)_PROXY automatically. */
export function createXOAuthDispatcher(env: NodeJS.ProcessEnv = process.env): EnvHttpProxyAgent | undefined {
  const fallback = env.all_proxy || env.ALL_PROXY || "";
  const httpProxy = env.http_proxy || env.HTTP_PROXY || fallback;
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || fallback || httpProxy;
  if (!httpProxy && !httpsProxy) return undefined;
  try {
    for (const value of [httpProxy, httpsProxy].filter(Boolean)) {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.pathname !== "/") throw new Error();
    }
    return new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: env.no_proxy ?? env.NO_PROXY ?? "" });
  } catch {
    // Proxy URLs may themselves contain credentials. Never retain/echo the cause.
    throw new Error("Invalid X OAuth proxy configuration. Use HTTP(S) proxy URLs in HTTP_PROXY/HTTPS_PROXY (or ALL_PROXY).");
  }
}
