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
  walletLinkConfirmed?: boolean;
  walletRevokeConfirmed?: boolean;
  /** Exact mint context. A prior wallet record alone is never mint approval. */
  mintSignatureId?: string;
  mintClaimInstanceId?: string;
  /** Active original-claimant session may start a wallet proof; not an OAuth approval. */
  mintRecipientConfirmed?: boolean;
  mintPreviousBindingId?: string | null;
  /** The server verified that this exact signature has no live/pending mint authority. */
  mintCanStart?: boolean;
  /** Same-origin destination after confirming a specific wallet action with X. */
  actionReturnTo?: string;
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

/** An active claimant session can start the exact mint's wallet ownership proof. */
export function walletLinkControls(params: AccountPanelView): string {
  if (!params.currentHandle || !params.csrfToken || !params.mintEnabled || !params.mintRecipientConfirmed || !params.mintSignatureId || !params.mintClaimInstanceId) return "";
  const csrf = escapeHtml(params.csrfToken ?? "");
  return `<div data-wallet-controls${params.localChainRehearsal ? " data-local-chain-rehearsal" : ""}><div class="auth-actions"><button class="auth-action" type="button" data-link-wallet data-wallet-provider="injected" data-mode="${params.wallet ? "replace" : "link"}" data-signature-id="${escapeHtml(params.mintSignatureId)}" data-claim-instance-id="${escapeHtml(params.mintClaimInstanceId)}" data-previous-binding-id="${escapeHtml(params.mintPreviousBindingId ?? "")}" data-csrf="${csrf}" data-chain-id="${escapeHtml(params.mintChainId)}"><span>Connect wallet</span></button></div><p class="inline-feedback" data-wallet-feedback role="status" aria-live="polite"></p><noscript><p>JavaScript is required to connect a wallet and verify the recipient.</p></noscript></div>`;
}

/** Private session-bound test tools. Render only in the DEV overlay. */
export function developmentWalletControls(params?: AccountPanelView): string {
  if (!params || params.previewOnly || !params.currentHandle || !params.csrfToken || !params.mintRecipientConfirmed || !params.mintSignatureId || !params.mintClaimInstanceId || !params.mintEnabled) return "";
  if (!params.fixtureMode && !params.localChainRehearsal) return "";
  const local = Boolean(params.localChainRehearsal);
  const button = `<button class="auth-action" type="button" data-link-wallet data-wallet-provider="${local ? "local" : "fixture"}" data-fixture="${!local}" data-mode="${params.wallet ? "replace" : "link"}" data-signature-id="${escapeHtml(params.mintSignatureId)}" data-claim-instance-id="${escapeHtml(params.mintClaimInstanceId)}" data-previous-binding-id="${escapeHtml(params.mintPreviousBindingId ?? "")}" data-csrf="${escapeHtml(params.csrfToken)}" data-chain-id="${local ? "31337" : escapeHtml(params.mintChainId)}"><span>${local ? "Use local TEST wallet" : "Use simulated wallet"}</span></button>`;
  return `<section class="rehearsal-page-note" data-wallet-controls${local ? " data-local-chain-rehearsal" : ""}><h2>Mint recipient test tools</h2><p>${local ? "Public test keys. Anvil 31337 only. Never send real funds." : "This simulates recipient verification for this mint. No wallet signature or Ethereum transaction is made."}</p>${local ? `<span class="local-wallet-address">${LOCAL_TEST_WALLET}</span>` : ""}<div class="auth-actions">${button}</div><p class="inline-feedback" data-wallet-feedback role="status" aria-live="polite"></p></section>`;
}

export function accountPanelContent(params: AccountPanelView): string {
  const signedIn = Boolean(params.currentHandle && params.csrfToken);
  const csrf = escapeHtml(params.csrfToken ?? "");
  const signIn = `<form method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login"><button class="auth-action" type="submit"><span>Sign in with X</span></button></form>`;
  const x = `<section class="account-panel-section" aria-label="X account"><div class="account-panel-row"><h3>X</h3><span>${signedIn ? xProfileLink(params.currentHandle!) : "Not signed in"}</span>${signedIn ? `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="auth-action auth-action-quiet" type="submit"><span>Log out</span></button></form>` : ""}</div>${!signedIn ? signIn : ""}</section>`;
  const content = params.previewOnly ? `<fieldset class="preview-controls" disabled><legend class="visually-hidden">Read-only account controls fixture</legend>${x}</fieldset>` : x;
  return `<div data-account-panel-content${params.localChainRehearsal ? " data-local-chain-rehearsal" : ""}>${content}</div>`;
}

export function accountPanelShell(initial?: AccountPanelView): string {
  const content = initial ? accountPanelContent(initial) : '<p class="auth-note">Open account controls to sign in.</p><a class="auth-action" href="/me"><span>Open My Collection</span></a>';
  return `<div class="account-menu" data-account-menu${initial?.previewOnly ? " data-account-preview" : ""}><a class="collection-shortcut" href="/me" aria-label="My Collection" aria-controls="account-panel" aria-expanded="false"><span class="collection-shortcut-dot" aria-hidden="true"></span></a><button class="account-menu-toggle" type="button" aria-label="Account controls" aria-controls="account-panel" aria-expanded="false"><span aria-hidden="true">⌄</span></button><section class="account-panel" id="account-panel" aria-labelledby="account-panel-heading"><h2 class="account-panel-heading" id="account-panel-heading"><a href="/me">My Collection</a></h2><div data-account-panel-body>${content}</div></section></div>`;
}
