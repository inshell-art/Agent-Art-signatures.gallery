export type InjectedProvider = {
  request: (request: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (name: string, listener: (...args: any[]) => void) => void;
  removeListener?: (name: string, listener: (...args: any[]) => void) => void;
  providers?: InjectedProvider[];
  isRabby?: boolean;
  isMetaMask?: boolean;
};
export type WalletChoice = { provider: InjectedProvider; key: string | null; name: string; rdns?: string };
type DiscoveryHost = {
  ethereum?: InjectedProvider;
  addEventListener: (name: string, listener: (event: any) => void) => void;
  removeEventListener: (name: string, listener: (event: any) => void) => void;
  dispatchEvent: (event: Event) => unknown;
};

/** Self-contained because the client embeds this function. Metadata is a label, not authentication. */
export function createWalletProviders(host: DiscoveryHost) {
  const entries: WalletChoice[] = [];
  const uuids = new Map<string, InjectedProvider>();
  // Object methods stay self-contained when tsx/esbuild preserves function names.
  const api = {
    valid(provider: any): provider is InjectedProvider { return provider && typeof provider.request === "function"; },
    announce(event: any) {
      const info = event?.detail?.info, provider = event?.detail?.provider;
      if (!api.valid(provider) || !info || typeof info.uuid !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(info.uuid)
        || typeof info.name !== "string" || !info.name.trim() || info.name.length > 80
        || typeof info.rdns !== "string" || info.rdns.length > 253 || info.rdns.split(".").some((label: string) => label.length > 63) || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(info.rdns)) return;
      const previous = uuids.get(info.uuid);
      if (previous && previous !== provider) return;
      uuids.set(info.uuid, provider);
      const existing = entries.find(entry => entry.provider === provider);
      // A provider cannot change its advertised identity after discovery.
      if (existing?.rdns) return;
      const entry = { provider, key: "eip6963:" + info.rdns, name: info.name.trim(), rdns: info.rdns };
      if (existing) Object.assign(existing, entry); else entries.push(entry);
    },
    discoverLegacy() {
      const aggregate = host.ethereum;
      const providers = Array.isArray(aggregate?.providers) && aggregate.providers.length ? aggregate.providers : [aggregate];
      for (const provider of providers) {
        if (!api.valid(provider) || entries.some(entry => entry.provider === provider)) continue;
        const brand = provider.isRabby ? "Rabby" : provider.isMetaMask ? "MetaMask" : null;
        entries.push({ provider, key: brand ? "legacy:" + brand.toLowerCase() : null, name: brand || "Injected wallet" });
      }
    },
    choices(): WalletChoice[] { api.discoverLegacy(); return entries.slice(); },
    restore(key: unknown): WalletChoice | null {
      if (typeof key !== "string") return null;
      const matches = api.choices().filter(entry => entry.key === key);
      return matches.length === 1 ? matches[0]! : null;
    },
    dispose() { host.removeEventListener("eip6963:announceProvider", api.announce); },
  };
  host.addEventListener("eip6963:announceProvider", api.announce);
  host.dispatchEvent(new Event("eip6963:requestProvider"));
  return { choices: api.choices, restore: api.restore, dispose: api.dispose };
}
