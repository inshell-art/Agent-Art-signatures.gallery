import { createHash } from "node:crypto";
import { MINT_CLIENT_SCRIPT } from "../v2/clientScript.js";
import { ACCOUNT_PANEL_SCRIPT } from "./accountPanelScript.js";
import { REHEARSAL_OVERLAY_SCRIPT } from "./rehearsalOverlayScript.js";
import { ACTION_TOOLTIP_SCRIPT } from "./actionTooltipScript.js";
import { CLAIM_NOTICE_SCRIPT } from "./claimNotice.js";
import { WITHDRAW_CLAIM_DIALOG_SCRIPT } from "./withdrawClaimDialog.js";

const versioned = (path: string, content: string) => `${path}?v=${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
export const MINT_SCRIPT_URL = versioned("/assets/mint.js", MINT_CLIENT_SCRIPT);
export const ACCOUNT_PANEL_SCRIPT_URL = versioned("/assets/account-panel.js", ACCOUNT_PANEL_SCRIPT);
export const REHEARSAL_SCRIPT_URL = versioned("/assets/rehearsal-overlay.js", REHEARSAL_OVERLAY_SCRIPT);
export const ACTION_TOOLTIP_SCRIPT_URL = versioned("/assets/action-tooltip.js", ACTION_TOOLTIP_SCRIPT);
export const CLAIM_NOTICE_SCRIPT_URL = versioned("/assets/claim-notice.js", CLAIM_NOTICE_SCRIPT);
export const WITHDRAW_CLAIM_DIALOG_SCRIPT_URL = versioned("/assets/withdraw-claim.js", WITHDRAW_CLAIM_DIALOG_SCRIPT);
