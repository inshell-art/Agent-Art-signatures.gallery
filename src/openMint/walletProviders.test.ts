import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { createWalletProviders, type InjectedProvider } from "./walletProviders.js";

const provider = (properties = {}): InjectedProvider => ({ request: vi.fn(async () => []), ...properties });
const info = (suffix = "1", rdns = "io.rabby") => ({ uuid: `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`, name: "Rabby", rdns, icon: "data:image/svg+xml,<svg onload='bad()'/>" });
function fixture(ethereum?: InjectedProvider) {
  const listeners = new Map<string, (event: any) => void>();
  const host = { ethereum, addEventListener: (name: string, listener: (event: any) => void) => { listeners.set(name, listener); }, removeEventListener: (name: string) => { listeners.delete(name); }, dispatchEvent: vi.fn() };
  const registry = createWalletProviders(host);
  const announce = (metadata: unknown, wallet: unknown) => listeners.get("eip6963:announceProvider")?.({ detail: { info: metadata, provider: wallet } });
  return { host, registry, announce, listeners };
}

describe("injected provider discovery", () => {
  it("remains standalone when serialized by the tsx development runtime", () => {
    const source = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import { createWalletProviders } from ${JSON.stringify(new URL("./walletProviders.ts", import.meta.url).href)}; process.stdout.write(createWalletProviders.toString());`], { encoding: "utf8" });
    const f = fixture();
    const registry = runInNewContext(`(${source})(host)`, { host: f.host, Event });
    expect(registry.choices()).toEqual([]);
    registry.dispose();
  });
  it("requests EIP-6963 discovery without contacting wallets and retains late announcements", () => {
    const f = fixture(), first = provider(), second = provider();
    expect(f.host.dispatchEvent.mock.calls[0]![0].type).toBe("eip6963:requestProvider");
    expect(f.registry.choices()).toEqual([]);
    f.announce(info(), first); f.announce(info("2", "io.metamask"), second);
    expect(f.registry.choices().map(choice => choice.provider)).toEqual([first, second]);
    expect(first.request).not.toHaveBeenCalled(); expect(second.request).not.toHaveBeenCalled();
  });

  it("deduplicates announcements and upgrades legacy metadata for the same provider", () => {
    const wallet = provider({ isRabby: true, isMetaMask: true }), f = fixture(wallet);
    expect(f.registry.choices()[0]!.name).toBe("Rabby");
    f.announce(info(), wallet); f.announce(info(), wallet);
    expect(f.registry.choices()).toEqual([{ provider: wallet, key: "eip6963:io.rabby", name: "Rabby", rdns: "io.rabby" }]);
    f.announce(info("2", "fake.changed"), wallet);
    expect(f.registry.choices()[0]!.rdns).toBe("io.rabby");
  });

  it("does not let a duplicate UUID replace a provider", () => {
    const f = fixture(), original = provider(); f.announce(info(), original); f.announce(info(), provider());
    expect(f.registry.restore("eip6963:io.rabby")?.provider).toBe(original);
  });

  it("requires explicit selection for ambiguous names and never restores a different brand", () => {
    const f = fixture(); f.announce(info(), provider()); f.announce(info("2"), provider());
    expect(f.registry.choices()).toHaveLength(2);
    expect(f.registry.restore("eip6963:io.rabby")).toBeNull();
    expect(f.registry.restore("eip6963:io.metamask")).toBeNull();
    expect(f.registry.restore({ key: "eip6963:io.rabby" })).toBeNull();
  });

  it("discovers legacy multi-provider arrays without choosing their aggregator", () => {
    const rabby = provider({ isRabby: true, isMetaMask: true }), metamask = provider({ isMetaMask: true });
    const f = fixture(provider({ providers: [rabby, metamask, rabby] }));
    expect(f.registry.choices().map(choice => choice.name)).toEqual(["Rabby", "MetaMask"]);
    expect(f.registry.restore("legacy:metamask")?.provider).toBe(metamask);
  });

  it("cannot automatically restore an unidentified legacy wallet or duplicate brand", () => {
    const f = fixture(provider()); expect(f.registry.choices()[0]!.key).toBeNull();
    expect(f.registry.restore(null)).toBeNull();
    f.host.ethereum = provider({ providers: [provider({ isRabby: true }), provider({ isRabby: true })] });
    expect(f.registry.restore("legacy:rabby")).toBeNull();
  });

  it.each([{ ...info(), uuid: "invalid" }, { ...info(), name: "" }, { ...info(), name: "a".repeat(81) }, { ...info(), rdns: "<img>" }, { ...info(), rdns: "io." + "a".repeat(64) }, null])("ignores malformed metadata %j", metadata => {
    const f = fixture(); f.announce(metadata, provider()); expect(f.registry.choices()).toEqual([]);
  });

  it("ignores a missing request method and removes discovery listeners on disposal", () => {
    const f = fixture(); f.announce(info(), {}); expect(f.registry.choices()).toEqual([]);
    f.registry.dispose(); expect(f.listeners.size).toBe(0);
  });
});
