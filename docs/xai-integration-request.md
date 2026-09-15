# xAI subscription OAuth integration request

Status: HUMAN-ESCALATION REQUEST SENT (user-reported) - awaiting reply. The user confirms replying to support@x.ai and reports no response yet. Actual forwarding to a human remains unconfirmed; no provider ticket, assigned human contact, or approval has been reported. Integration eligibility remains undetermined.

Prepared: 2026-09-14

Internal reference: `SG-XAI-OAUTH-2026-09-14` (our reference, not an xAI ticket).

## Working arrangement

The assistant coordinates the request; the user performs external communication and account actions.

- **Assistant:** maintain this status/history, distinguish confirmed facts from pending items, draft messages, interpret replies, and give one clear next action with a completion criterion.
- **User:** review and send emails or forms, complete required sign-ins/permissions/terms, and report the outcome here. Account approvals, purchases, and sending correspondence are not delegated to the assistant by this arrangement.
- **Update loop:** assistant proposes the next action; user performs it and reports back; assistant records the reported result, any ticket/reference, blockers, and the next checkpoint. Attribute user-reported events as such rather than claiming independent delivery verification.
- **Privacy:** no passwords, API keys, OAuth tokens, or sensitive account screenshots are needed for tracking. Record only non-sensitive correspondence summaries here.
- **Follow-up:** choose a dated checkpoint after the user confirms sending. This document alone does not schedule reminders or monitor an inbox; recurring reminders require a separately configured automation.

### Current user action

No additional email is needed now. The user reports that the human-escalation reply was sent to `support@x.ai` and no response has arrived. Share the next response here, including any ticket or assigned contact. Both the project sender, `this.agent.art@gmail.com`, and recipient are user-confirmed; delivery and mailbox state have not been independently inspected.

The sending step is complete based on user confirmation. Actual handoff, an assigned contact, and an eligibility decision remain separate pending milestones. At the 2026-09-17 checkpoint, review the handoff status; if no human connection has been reported, prepare a same-thread follow-up. This is a recorded checkpoint, not a scheduled reminder or inbox monitor. In parallel, continue the app-paid Grok assessment work; this does not authorize live API spending.

## Latest response and interpretation

On 2026-09-14 the user reported resending the same inquiry after correcting the sender address, and shared another reply attributed to Zach from SpaceXAI, signed Grok. The user subsequently confirmed the corrected sender as `this.agent.art@gmail.com` and the xAI recipient as `Zach from SpaceXAI <support@x.ai>`. The correction concerned the sender, not xAI's recipient address. The latest email displayed 5:19 PM; its calendar date and timezone were not provided. These are user-confirmed details, not independently inspected mailbox headers. This record preserves a non-sensitive summary, not the full correspondence.

- The latest reply describes standard API access through API keys and confirms native X Search is available through that route.
- It identifies hosted OAuth registration, subscription-funded usage, token management and billing as outside the standard documentation, and says engineering needs to review the request.
- It does **not** confirm that escalation has happened or supply an assigned reviewer, ticket, eligibility decision, approval, or OAuth client.

Treat this as acknowledgement that engineering review is needed, not an engineering decision or confirmed handoff. The user has now requested escalation and reports no reply; this does not establish that forwarding occurred. The earlier 4:52 PM reply offered a human connection and recommended Contact Sales, but that belonged to the earlier sending history and must not be presented as a new offer in the 5:19 PM response. Keep the sales form as a subsequent escalation option if needed. The app-paid fallback remains the implementation path while subscription eligibility is unresolved.

## Human-handoff reply prepared copy

Status: REPLY SENT (user-reported on 2026-09-14), awaiting response. The prepared wording below is retained for context; the exact sent text and timestamp have not been independently verified.

Reply in the corrected-send thread; keep the subject and `SG-XAI-OAUTH-2026-09-14` reference.

Hello,

Thank you. Please forward this request to a human member of API engineering or integrations/partnerships and confirm once it has been escalated. Please provide a ticket/reference number or the assigned contact.

The decision we need is whether our hosted application can obtain its own approved integration to use consenting users' Grok subscription allowances for backend-initiated Responses API requests with native X Search. We understand the separately billed API-key option.

Please have the reviewing team confirm whether this is supported today, available through a private pilot/partnership, or unavailable to our app. If another team handles these requests, please connect us directly.

Please retain this email thread and reference: SG-XAI-OAUTH-2026-09-14.

Thank you,
Signatures Gallery / Agent Art

## Recipient and tracking

Use the user-confirmed project contact **this.agent.art@gmail.com** and recipient **support@x.ai** (display name: Zach from SpaceXAI), requesting routing to API integrations or partnerships. xAI lists this recipient address on its [official contact page](https://x.ai/contact). Its [Contact Sales form](https://x.ai/contact-sales) is an alternative escalation route; reference the original request there instead of opening unrelated threads.

The user confirmed that the resend corrected their own sender address; the xAI recipient was `support@x.ai`. Do not describe the earlier send as having gone to a wrong xAI recipient. Mailbox headers and delivery have not been independently inspected.

Keep the subject and original email thread. Ask for a ticket/reference number, retain the sent timestamp and acknowledgement, and record the written response. A Grok-generated answer, successful consumer login, or another integration's public client ID is not approval for our app. Do not attach credentials, cookies, account exports, or private conversations.

## Original inquiry draft

To: support@x.ai

Subject: OAuth integration eligibility - Signatures Gallery [SG-XAI-OAUTH-2026-09-14]

Hello xAI team,

Please route this request to the team responsible for API integrations or partnerships and provide a ticket/reference number.

We are developing Signatures Gallery (signatures.gallery), a generative-art application. A user supplies a public X handle. Grok independently researches the account using native X Search and chooses an MBTI-inspired artwork attribute. This is artistic interpretation, not a psychological diagnosis. The accepted result is stored and used to render artwork that anyone may mint as a transferable on-chain token; minting does not claim ownership of the X account or imply its endorsement.

We want each consenting user to fund that assessment from their existing Grok subscription allowance. Our hosted backend would construct a fresh, fixed-policy request to `/v1/responses` with native `x_search` and receive the response directly. Users would not submit an authoritative MBTI or private chat transcript. We would not reuse another application's OAuth client or extract browser session credentials.

Could you confirm:

1. Is this hosted, multi-user integration and subscription-funded usage supported, and may we register our own OAuth client? If so, what is the application/approval process?
2. Which plans, models, and native X Search capabilities are eligible? Do tokens and search charges both consume subscription allowance, or are any API credits required?
3. What minimum scopes, grant types, redirect requirements, and server-side token-storage/refresh rules apply?
4. What usage limits, exhaustion behavior, data-retention requirements, and applicable terms would govern this use case?

We are preparing a small, capped pilot. If this is not currently available, please confirm that too; we can use separately billed team API access in the meantime.

Thank you,
Signatures Gallery / Agent Art

## Correspondence record

| Field | Value |
| --- | --- |
| Tracking owner | Assistant |
| Sending/account-action owner | User |
| Sender | this.agent.art@gmail.com - corrected sender address, confirmed by user |
| Recipient | Zach from SpaceXAI <support@x.ai> - confirmed by user |
| Sent at | Initial send, corrected-address resend, and human-escalation reply all reported by user on 2026-09-14; exact send timestamps not provided |
| Channel | Email from the corrected project sender to support@x.ai; user-confirmed addresses, not independently inspected headers |
| Provider ticket/reference | Not reported |
| Acknowledgement | Latest reply displayed 5:19 PM, attributed to Zach from SpaceXAI and signed Grok, shared by user on 2026-09-14; not independently verified |
| Human handoff | Escalation reply sent to support@x.ai, user-reported; no response yet. Actual forwarding and an assigned human contact remain unconfirmed |
| Written eligibility decision | Undetermined; latest support reply does not establish approval, rejection, or an active engineering review |
| Approved client/scopes/plans | None |
| Next action | Await the escalation response; user shares it here. Assistant records any contact/ticket and decision separately and continues app-paid fallback preparation |
| Follow-up checkpoint | 2026-09-17: review human-handoff status; follow up if sent but no connection reported; no reminder scheduled |

Do not change the status to sent without user confirmation or delivery evidence; label the source of confirmation. If escalating through Contact Sales, include the internal reference and any provider ticket number. Keep private correspondence out of public repository history; store only an approved, non-sensitive summary and reference here.

## Progress history

| Date | Event | Evidence/status |
| --- | --- | --- |
| 2026-09-14 | Prepared the integration inquiry and paid-fallback readiness checklist | Local documents only; no message sent or credit spent |
| 2026-09-14 | Agreed coordination model: assistant tracks and drafts; user sends and performs account actions | User instruction in this chat |
| 2026-09-14 | Assigned first user action: send the inquiry to support@x.ai | Awaiting user confirmation; no provider ticket recorded |
| 2026-09-14 | User reported "sent"; moved to awaiting xAI response and began paid-fallback cost research | User confirmation in this chat; exact send timestamp, delivery verification, and provider ticket not supplied |
| 2026-09-14 | Completed [paid-fallback cost research](paid-grok-cost-research.md), including pricing-transition analysis and a proposed controlled pilot | Documentation and offline audit only; no live inference, purchase, or runtime changes |
| 2026-09-14 | User shared a support reply attributed to Zach, SpaceXAI's AI Agent; recorded acknowledgement and offered escalation | User-provided email text; no ticket, human owner, or eligibility decision supplied |
| 2026-09-14 | Prepared a same-thread reply requesting the offered human connection and a clear eligibility decision | Draft only; awaiting user confirmation of sending |
| 2026-09-14 | User corrected the earlier sending history: an address was wrong, so the same inquiry was resent using the correct address | User report; actual corrected address and sender-versus-recipient distinction not supplied |
| 2026-09-14 | Recorded the corrected-send reply displayed at 5:19 PM; it says engineering review is needed without confirming escalation | User-provided email text; no ticket, reviewer or eligibility decision supplied |
| 2026-09-14 | Revised the follow-up to request explicit forwarding and escalation confirmation in the corrected-send thread | Draft only; not sent |
| 2026-09-14 | User clarified the correction: sender is this.agent.art@gmail.com; xAI recipient is Zach from SpaceXAI <support@x.ai> | User confirmation; sender-versus-recipient ambiguity resolved. No human-handoff send or escalation confirmed |
| 2026-09-14 | User confirmed sending the human-escalation reply to support@x.ai and reported no response yet; asked to proceed with the Grok API assessment solution | User report, not independent delivery verification. Human routing and integration eligibility remain unconfirmed; no paid request authorized |

## Parallel preparation

The paid fallback is tracked in [Paid Grok fallback preparation](paid-grok-fallback.md). It does not depend on subscription-OAuth approval. Preparing that path does not authorize buying credits, enabling auto-recharge, or sending a live inference request.
