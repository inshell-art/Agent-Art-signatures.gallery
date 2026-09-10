import { LOCAL_TEST_WALLET } from "../local/wallet.js";
import { xProfileLink } from "./xProfile.js";
import type { WalletView } from "./pages.js";

export interface AccountPanelView {
  currentHandle?: string;
  csrfToken?: string;
  wallet?: WalletView | null;
  mintEnabled: boolean;
  mintChainId: string;
  fixtureMode: boolean;
  localOAuthMode?: boolean;
  localChainRehearsal?: boolean;
  reauthRequired?: boolean;
  /** Development presentation fixture: native controls disabled, no live refresh. */
  previewOnly?: boolean;
}

/** Provider configuration, not a claim about any historical fixture's identity. */
export function developmentAuthenticationNotice(params?: AccountPanelView): string {
  if (!params || params.previewOnly || !params.fixtureMode && !params.localChainRehearsal) return "";
  const simulated = params.localOAuthMode ?? params.fixtureMode;
  return `<section class="rehearsal-page-note" data-dev-x-auth="${simulated ? "emulator" : "real"}"><h2>X authentication · ${simulated ? "simulator" : "real OAuth"}</h2><p>${simulated ? "Sign-in uses the local simulator. No X account is authenticated." : "Sign-in opens X for real account consent. The simulator is disabled. Choosing “Claim with X” saves the local claim after the matching account returns. Ordinary account sign-in creates no claim."}</p><p>Seeded accounts remain simulated. This provider setting does not change historical records into verified X claims.</p></section>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

/** Call only after identity and mint availability have been checked. */
export function walletLinkControls(params: AccountPanelView): string {
  const csrf = escapeHtml(params.csrfToken ?? "");
  return `<div data-wallet-controls${params.localChainRehearsal ? " data-local-chain-rehearsal" : ""}><div class="auth-actions"><button class="auth-action" type="button" data-link-wallet data-wallet-provider="injected" data-mode="link" data-csrf="${csrf}" data-chain-id="${escapeHtml(params.mintChainId)}"><span>Link wallet</span></button></div><p class="inline-feedback" data-wallet-feedback role="status" aria-live="polite"></p><noscript><p>JavaScript is required to connect and prove ownership of a wallet.</p></noscript></div>`;
}

/** Private session-bound test tools. Render only in the DEV overlay. */
export function developmentWalletControls(params?: AccountPanelView): string {
  if (!params || params.previewOnly || !params.currentHandle || !params.csrfToken || params.reauthRequired || !params.mintEnabled) return "";
  if (!params.fixtureMode && !params.localChainRehearsal) return "";
  const local = Boolean(params.localChainRehearsal);
  if (!local && params.wallet) return "";
  const button = `<button class="auth-action" type="button" data-link-wallet data-wallet-provider="${local ? "local" : "fixture"}" data-fixture="${!local}" data-mode="link" data-csrf="${escapeHtml(params.csrfToken)}" data-chain-id="${local ? "31337" : escapeHtml(params.mintChainId)}"><span>${local ? "Use local TEST wallet" : "Use simulated wallet"}</span></button>`;
  return `<section class="rehearsal-page-note" data-wallet-controls${local ? " data-local-chain-rehearsal" : ""}><h2>Wallet test tools</h2><p>${local ? "Public test keys. Anvil 31337 only. Never send real funds." : "This creates a simulated wallet binding. No wallet signature or Ethereum transaction is made."}</p>${local ? `<span class="local-wallet-address">${LOCAL_TEST_WALLET}</span>` : ""}<div class="auth-actions">${button}</div><p class="inline-feedback" data-wallet-feedback role="status" aria-live="polite"></p></section>`;
}

export function accountPanelContent(params: AccountPanelView): string {
  const signedIn = Boolean(params.currentHandle && params.csrfToken);
  const csrf = escapeHtml(params.csrfToken ?? "");
  const signIn = `<form method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login"><button class="auth-action" type="submit"><span>${params.reauthRequired ? "Reauthenticate with X" : "Sign in with X"}</span></button></form>`;
  const x = `<section class="account-panel-section" aria-label="X account"><div class="account-panel-row"><h3>X</h3><span>${signedIn ? xProfileLink(params.currentHandle!) : "Not signed in"}</span>${signedIn ? `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="auth-action auth-action-quiet" type="submit"><span>Log out</span></button></form>` : ""}</div>${!signedIn || params.reauthRequired ? signIn : ""}${params.reauthRequired ? '<p class="auth-note">Refresh your X identity before changing the wallet or minting.</p>' : ""}</section>`;
  const binding = signedIn ? params.wallet : null;
  const address = binding ? escapeHtml(binding.address) : "";
  const shortAddress = binding ? escapeHtml(`${binding.address.slice(0, 7)}…${binding.address.slice(-5)}`) : "Not linked";
  const chainId = escapeHtml(binding?.chainId ?? params.mintChainId);
  const provider = `data-wallet-provider="injected" data-fixture="${params.fixtureMode && !params.localChainRehearsal}" data-mode="${binding ? "replace" : "link"}" data-csrf="${csrf}" data-chain-id="${chainId}"`;
  const browserWallet = `<button class="auth-action${binding || params.localChainRehearsal ? " auth-action-quiet" : ""}" type="button" data-link-wallet ${provider}><span>${binding ? "Replace wallet" : "Link wallet"}</span></button>`;
  const walletSignIn = `<form class="auth-actions" method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login"><button class="auth-action" type="submit"><span>${binding ? "Replace wallet" : "Link wallet"}</span></button></form>`;
  const controls = !signedIn
    ? walletSignIn + '<p class="auth-note">Sign in with X first, then prove wallet ownership.</p>'
    : !params.mintEnabled
      ? '<p class="auth-note">Minting paused. Existing claims and provenance remain readable.</p>'
      : params.reauthRequired
        ? walletSignIn + '<p class="auth-note">Wallet management is available after reauthentication.</p>'
        : binding ? `<div class="auth-actions">${browserWallet}<button class="auth-action auth-action-quiet" type="button" data-revoke-wallet data-csrf="${csrf}"><span>Revoke wallet</span></button></div>` : walletLinkControls(params);
  const details = signedIn ? `<details class="auth-disclosure account-wallet-details"><summary>Wallet details</summary>${binding ? `<p>Wallet linked for minting</p><span class="local-wallet-address">${address}</span><p>${escapeHtml(binding.chainName)} · proved ${escapeHtml(binding.provedAt.toISOString())}</p>` : ""}<p>Connecting alone creates no binding. A signed proof links the wallet to your account.</p><p>Claims stay with the claimant; a transfer changes the token holder.</p></details>` : "";
  const inlineControls = signedIn && params.mintEnabled && !params.reauthRequired && !binding;
  const wallet = `<section class="account-panel-section" aria-label="Wallet"><div class="account-panel-row"><h3>Wallet</h3><span title="${address}">${shortAddress}</span></div>${controls}${details}${inlineControls ? "" : '<p class="inline-feedback" data-wallet-feedback role="status" aria-live="polite"></p>'}</section>`;
  const content = params.previewOnly ? `<fieldset class="preview-controls" disabled><legend class="visually-hidden">Read-only account controls fixture</legend>${x}${wallet}</fieldset>` : x + wallet;
  return `<div data-account-panel-content${params.localChainRehearsal ? " data-local-chain-rehearsal" : ""}>${content}</div>`;
}

export function accountPanelShell(initial?: AccountPanelView): string {
  const content = initial ? accountPanelContent(initial) : '<p class="auth-note">Open account controls to sign in or manage a wallet.</p><a class="auth-action" href="/me"><span>Open My Collection</span></a>';
  return `<div class="account-menu" data-account-menu${initial?.previewOnly ? " data-account-preview" : ""}><a class="collection-shortcut" href="/me" aria-label="My Collection" aria-controls="account-panel" aria-expanded="false"><span class="collection-shortcut-dot" aria-hidden="true"></span></a><button class="account-menu-toggle" type="button" aria-label="Account controls" aria-controls="account-panel" aria-expanded="false"><span aria-hidden="true">⌄</span></button><section class="account-panel" id="account-panel" aria-labelledby="account-panel-heading"><h2 class="account-panel-heading" id="account-panel-heading">My Collection</h2><div data-account-panel-body>${content}</div></section></div>`;
}
