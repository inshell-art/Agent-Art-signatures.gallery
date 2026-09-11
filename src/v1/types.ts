export type OAuthPurpose = "claim" | "account_login" | "sensitive_action";

/** Server-resolved targets, never a general permission to act on an account. */
export type SensitiveActionIntent =
  | { kind: "mint_recipient"; signatureId: string; claimInstanceId: string; chainId: string; previousBindingId: string | null }
  | { kind: "wallet_link"; chainId: string; previousBindingId: string | null }
  | { kind: "wallet_revoke"; chainId: string; previousBindingId: string }
  | { kind: "claim_withdraw"; signatureId: string; claimInstanceId: string };
