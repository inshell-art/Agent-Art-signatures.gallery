import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, keccak256, parseAbi, recoverMessageAddress, type Hex } from "viem";
import type { MintAuthorizationResponse } from "../v2/service.js";
import { assertOwnedAnvil, validateLocalRuntime } from "./runtimeGuards.js";
import { LOCAL_TEST_RECIPIENT, LOCAL_TEST_WALLET, validateLocalMintPayload } from "./wallet.js";

/** Runs only against an already-running, repository-owned local rehearsal.
 * No reset/deploy/admin RPC, private key input, external OAuth, or external RPC.
 * Normal execution requires an explicit test-transaction flag. --verify is read-only.
 */
const args = process.argv.slice(2);
const verifyOnly = args[0] === "--verify" && args.length === 2;
if (!verifyOnly && !(args.length === 1 && args[0] === "--execute-local-test-transactions")) {
  throw new Error("Use --execute-local-test-transactions to create a Bob claim, mint and transfer using only the local TEST wallet; or --verify SIGNATURE_ID for a read-only restart check.");
}
const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const runtime = validateLocalRuntime(JSON.parse(readFileSync(resolve(repoRoot, ".local/rehearsal/runtime.json"), "utf8")));
const port = Number(process.env.LOCAL_APP_PORT ?? 3000);
assert(Number.isSafeInteger(port) && port >= 1 && port <= 65535, "LOCAL_APP_PORT must be a valid port");
const origin = `http://127.0.0.1:${port}`;
const chain = createPublicClient({ transport: http(runtime.rpcUrl, { retryCount: 0, timeout: 5_000, fetchOptions: { redirect: "error" } }) });
const tokenAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function tokenURI(uint256 tokenId) view returns (string)"]);
let cookie = "";
let csrf = "";

async function guard(): Promise<void> {
  assertOwnedAnvil(repoRoot, runtime.rpcUrl);
  const [chainId, code, deployment] = await Promise.all([chain.getChainId(), chain.getCode({ address: runtime.contract }), chain.getTransactionReceipt({ hash: runtime.deploymentTransaction })]);
  assert.equal(chainId, 31337, "Only Anvil chain 31337 may be used");
  assert(code && keccak256(code) === runtime.runtimeCodeHash, "Pinned local contract code changed");
  assert.equal(deployment.status, "success", "Local deployment must be successful");
  assert.equal(deployment.blockNumber, BigInt(runtime.deploymentBlockNumber), "Local deployment moved");
  assert.equal(getAddress(runtime.roleAccounts.mintWallet), LOCAL_TEST_WALLET, "Runtime wallet must be public Anvil test account 6");
}

async function request(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, "Test requests must remain on the configured local app");
  if (init.method && init.method !== "GET" && init.method !== "HEAD") {
    assert(!verifyOnly, "Read-only verification cannot send mutations");
    await guard();
  }
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { ...(auth && cookie ? { Cookie: cookie } : {}), ...init.headers } });
  const nextCookie = response.headers.get("set-cookie");
  if (nextCookie && auth) cookie = nextCookie.split(";")[0]!;
  return response;
}

function postForm(path: string, values: Record<string, string>): Promise<Response> {
  return request(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, "Sec-Fetch-Site": "same-origin" }, body: new URLSearchParams(values) });
}

function postJson(path: string, values: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return request(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": csrf, ...headers }, body: JSON.stringify(values) });
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: { code?: string } };
    throw new Error(`Local test request rejected: HTTP ${response.status}, ${error.error?.code ?? "unknown error"}`);
  }
  return response.json() as Promise<T>;
}

function redirectLocation(response: Response): string {
  assert([302, 303].includes(response.status), `Expected local redirect, got ${response.status}`);
  const location = response.headers.get("location");
  assert(location && new URL(location, origin).origin === origin, "Redirect must remain local");
  return location;
}

interface Status { signatureId: string; state: string; label: string; chainId: string; contract: string; tokenId: string; txHash: Hex; currentTokenHolder: string; mintWallet: string; finality: string; }
async function statusOf(signatureId: string): Promise<Status> {
  assert(/^sg1_[a-z2-7]{52}$/.test(signatureId), "Use a canonical signature ID");
  return json<Status>(await request(`/api/v2/signatures/${signatureId}/mint-status`));
}

async function waitForStatus(signatureId: string, condition: (status: Status) => boolean): Promise<Status> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await statusOf(signatureId);
    if (condition(status)) return status;
    assert(!["quarantined", "reconciliation_required"].includes(status.state), `Local reconciliation halted: ${status.state}`);
    await pause(500);
  }
  throw new Error("Local indexing did not reach the expected state within 30 seconds. No automatic resend/reset was attempted.");
}

async function verifyProjection(signatureId: string): Promise<Status> {
  const status = await statusOf(signatureId);
  assert.equal(status.state, "finalized", "Expected locally promoted mint");
  assert.equal(status.chainId, "31337");
  assert.equal(getAddress(status.contract), getAddress(runtime.contract));
  assert.equal(getAddress(status.mintWallet), LOCAL_TEST_WALLET);
  assert.match(status.finality, /local|single node/i, "Finality must be explicitly local");
  const [owner, receipt, detail, gallery] = await Promise.all([
    chain.readContract({ address: runtime.contract, abi: tokenAbi, functionName: "ownerOf", args: [BigInt(status.tokenId)] }),
    chain.getTransactionReceipt({ hash: status.txHash }),
    request(`/signatures/${signatureId}`), request("/?tab=minted"),
  ]);
  assert.equal(getAddress(owner), getAddress(status.currentTokenHolder), "Indexed holder must agree with Anvil ownerOf");
  assert.equal(receipt.status, "success");
  const detailHtml = await detail.text();
  assert(detailHtml.includes('data-signature-status="claimed"') && detailHtml.includes('data-signature-status="minted"'), "Claim and mint must share the same canonical detail");
  assert((await gallery.text()).includes(signatureId), "Minted gallery must expose the locally promoted work");
  return status;
}

await guard();
if (verifyOnly) {
  const status = await verifyProjection(args[1]!);
  console.log(JSON.stringify({ passed: true, mode: "read-only-restart-verification", signatureId: status.signatureId, tokenId: status.tokenId, mintTransaction: status.txHash, currentHolder: status.currentTokenHolder, finality: status.finality }));
} else {
  console.log("Rehearsing one Bob claim using emulated OAuth, a real local wallet proof, and real Anvil mint/transfer transactions. No external network or real funds.");
  assert.equal((await request("/api/local/wallet", {}, false)).status, 401, "Local wallet info must require a signed-in session");
  const gr0k = String(randomInt(1, 101));
  const preview = await (await request(`/s/bob/${gr0k}`)).text();
  const form = preview.match(/<form[^>]*action="\/auth\/x\/start"[^>]*>[\s\S]*?<\/form>/)?.[0];
  assert(form, "Preview must expose the combined sign-in-and-claim form");
  const fields = Object.fromEntries([...form.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
  assert.equal(fields.claim_intent, "claim-on-return-v1");
  const started = await postForm("/auth/x/start", fields);
  const authorizationPath = redirectLocation(started);
  assert(authorizationPath.startsWith("/dev/oauth/x/authorize?request="), "Only the local OAuth emulator is allowed");
  const requestId = new URL(authorizationPath, origin).searchParams.get("request");
  assert(requestId);
  const decision = await postForm("/dev/oauth/x/authorize", { request: requestId, decision: "approve", account: "bob" });
  const callback = await request(redirectLocation(decision));
  const reviewPath = redirectLocation(callback);
  assert(/^\/signatures\/sg1_[a-z2-7]{52}$/.test(reviewPath));
  const completed = await (await request(reviewPath)).text();
  assert(completed.includes('data-signature-status="claimed"'));
  assert(!completed.includes('action="/api/v1/signatures"'), "OAuth must complete the claim with no second confirmation");
  const panel = await json<{ html: string }>(await request("/api/v1/account-panel"));
  csrf = panel.html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  assert(csrf, "Authenticated panel must provide the active session CSRF token");
  assert(!/data-link-wallet|data-revoke-wallet|aria-label="Wallet"/.test(panel.html), "Global account controls must remain X-only");
  const signatureId = reviewPath.slice("/signatures/".length);
  assert(/^sg1_[a-z2-7]{52}$/.test(signatureId));
  assert.equal((await statusOf(signatureId)).state, "unminted", "An explicit claim must not implicitly mint");
  console.log(`Claimed @bob at gr0k ${gr0k}: ${signatureId}`);

  const mintPath = `/signatures/${signatureId}/mint`;
  const entry = await (await request(mintPath)).text();
  assert(entry.includes('data-mint-entry="wallet"'), "A new mint must require its own recipient verification, even for a previous wallet");
  assert(!entry.includes('name="action" value="mint_recipient"'), "An active X session must not require another OAuth trip to verify a mint recipient");
  const proofControl = [...entry.matchAll(/<button\b[^>]*data-link-wallet[^>]*>/g)]
    .map(match => match[0]).find(candidate => candidate.includes('data-wallet-provider="local"'));
  assert(proofControl, "The signed-in mint entry must expose its guarded local TEST recipient proof in DEV");
  const proofFields = Object.fromEntries([...proofControl.matchAll(/\b(data-[a-z-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
  assert.equal(proofFields["data-signature-id"], signatureId);
  assert(proofFields["data-claim-instance-id"], "Recipient proof must bind the exact current claim instance");
  assert.equal(proofFields["data-csrf"], csrf);
  assert.equal(proofFields["data-chain-id"], "31337");
  assert.equal(typeof proofFields["data-previous-binding-id"], "string", "The current recipient snapshot must be explicit, even when no recipient exists");
  const previousBindingId = proofFields["data-previous-binding-id"] || null;
  assert(previousBindingId === null || /^0x[0-9a-f]{64}$/i.test(previousBindingId), "Previous recipient must be a precise binding ID");
  const mintTarget = { signatureId, claimInstanceId: proofFields["data-claim-instance-id"]! };

  const wallet = await json<{ address: string; chainId: string; recipientAddress: string; contract: string }>(await request("/api/local/wallet"));
  assert.equal(getAddress(wallet.address), LOCAL_TEST_WALLET);
  assert.equal(getAddress(wallet.recipientAddress), LOCAL_TEST_RECIPIENT);
  assert.equal(wallet.chainId, "31337");
  assert.equal(getAddress(wallet.contract), getAddress(runtime.contract));
  const challengeRequest = { walletAddress: wallet.address, chainId: wallet.chainId, ...mintTarget, recipientConsent: true, previousBindingId };
  assert.equal((await postJson("/api/v2/wallet-bindings/challenge", challengeRequest, { "X-CSRF-Token": "wrong" })).status, 403, "Wrong CSRF must fail before any wallet action");
  const unconfirmed = await postJson("/api/v2/wallet-bindings/challenge", { ...challengeRequest, recipientConsent: false });
  assert.equal(unconfirmed.status, 400, "A signed-in session must not bypass explicit recipient consent");
  assert.equal((await unconfirmed.json() as { error: { code: string } }).error.code, "REQUEST_CONFIRMATION_INVALID");
  const originalCookie = cookie;
  const challenge = await json<{ challengeId: string; message: string; walletAddress: string; chainId: string }>(await postJson("/api/v2/wallet-bindings/challenge", challengeRequest));
  assert.equal(getAddress(challenge.walletAddress), LOCAL_TEST_WALLET);
  assert.equal(challenge.chainId, "31337");
  assert(challenge.message.includes(signatureId) && challenge.message.includes(mintTarget.claimInstanceId), "SIWE must identify the exact work and claim being authorized");
  assert.equal(cookie, originalCookie, "Recipient verification must use the active app session without another OAuth rotation");
  const proof = await json<{ walletProof: Hex }>(await postJson("/api/local/wallet/sign", { challengeId: challenge.challengeId }));
  assert.equal(await recoverMessageAddress({ message: challenge.message, signature: proof.walletProof }), LOCAL_TEST_WALLET);
  const verifiedRecipient = await json<{ walletBindingId: Hex; walletAddress: string; chainId: string }>(await postJson("/api/v2/wallet-bindings/confirm", { challengeId: challenge.challengeId, walletProof: proof.walletProof }));
  assert.match(verifiedRecipient.walletBindingId, /^0x[0-9a-f]{64}$/i);
  assert.equal(getAddress(verifiedRecipient.walletAddress), LOCAL_TEST_WALLET);
  assert.equal(verifiedRecipient.chainId, "31337");
  assert.equal((await postJson("/api/v2/wallet-bindings/confirm", { challengeId: challenge.challengeId, walletProof: proof.walletProof })).status, 409, "SIWE challenge replay must fail");
  assert.equal((await postJson("/dev/v2/wallet-bindings/seed", {})).status, 404, "Fake fixture wallet seeding must be unavailable");
  assert.equal((await postJson(`/dev/v2/signatures/${signatureId}/advance`, {})).status, 404, "Fake fixture lifecycle advancement must be unavailable");
  console.log("Active X session and exact-mint recipient SIWE proof verified without extra OAuth; consent, CSRF, replay and fixture-only shortcuts rejected.");

  const authorizePath = `/api/v2/signatures/${signatureId}/mint-authorizations`;
  const review = await (await request(mintPath)).text();
  const authorizationForm = review.match(/<form\b[^>]*class="mint-authorization-form"[^>]*>[\s\S]*?<\/form>/)?.[0];
  assert(authorizationForm, "Verified recipient must reach an explicit mint review");
  const reviewAttributes = Object.fromEntries([...authorizationForm.matchAll(/\b(data-[a-z-]+|action)="([^"]*)"/g)].map(match => [match[1], match[2]]));
  assert.equal(reviewAttributes.action, authorizePath);
  assert.equal(reviewAttributes["data-signature-id"], signatureId);
  assert.equal(reviewAttributes["data-claim-instance-id"], mintTarget.claimInstanceId);
  assert.equal(reviewAttributes["data-wallet-binding-id"], verifiedRecipient.walletBindingId);
  assert.equal(getAddress(reviewAttributes["data-wallet"]!), LOCAL_TEST_WALLET);
  assert.equal(reviewAttributes["data-chain-id"], "31337");
  assert.equal(getAddress(reviewAttributes["data-contract"]!), getAddress(runtime.contract));
  assert(authorizationForm.includes('name="permanence_acknowledged"'), "Mint review must require explicit publication consent");
  assert(!/name="permanence_acknowledged"[^>]*\bchecked\b/.test(authorizationForm), "Publication consent must not be preselected");
  assert(review.includes("<dt>Project fee</dt><dd>None</dd>"), "No project fee may be added by the rehearsal");
  const reviewedSnapshot = { walletBindingId: reviewAttributes["data-wallet-binding-id"]!, recipient: reviewAttributes["data-wallet"]! };
  assert.equal((await postJson(authorizePath, {})).status, 409, "Missing permanence acknowledgement must not authorize");
  assert.equal((await postJson(authorizePath, {}, { Origin: "https://outside.invalid", "X-Mint-Permanence-Acknowledged": "1" })).status, 403, "Cross-origin authorization must fail");
  const consent = { "X-Mint-Permanence-Acknowledged": "1" };
  const authorization = await json<MintAuthorizationResponse>(await postJson(authorizePath, reviewedSnapshot, consent));
  validateLocalMintPayload(authorization, runtime.contract);
  assert.equal(authorization.authorization.walletBindingId, reviewedSnapshot.walletBindingId);
  assert.equal(getAddress(authorization.authorization.mintWallet), getAddress(reviewedSnapshot.recipient));
  assert.equal(authorization.authorization.signatureDigest, reviewAttributes["data-signature-digest"]);
  assert.equal(authorization.authorization.svgSha256, `0x${reviewAttributes["data-svg-sha256"]}`);
  assert.equal(authorization.authorization.pngSha256, `0x${reviewAttributes["data-png-sha256"]}`);
  assert.equal(authorization.authorization.metadataSha256, reviewAttributes["data-metadata-sha256"]);
  assert.equal(authorization.authorization.tokenURIHash, reviewAttributes["data-token-uri-hash"]);
  assert.equal(authorization.tokenURI, reviewAttributes["data-token-uri"]);
  const again = await json<MintAuthorizationResponse>(await postJson(authorizePath, reviewedSnapshot, consent));
  assert.deepEqual(again, authorization, "Repeated authorization must return the same exact frozen authorization");
  const svgBefore = Buffer.from(await (await request(`/artifacts/${signatureId}.svg`)).arrayBuffer());
  assert.equal(createHash("sha256").update(svgBefore).digest("hex"), authorization.authorization.svgSha256.slice(2));

  const sent = await json<{ txHash: Hex }>(await postJson("/api/local/wallet/mint", { authorizationId: authorization.authorization.authorizationId }, consent));
  const duplicate = await json<{ txHash: Hex }>(await postJson("/api/local/wallet/mint", { authorizationId: authorization.authorization.authorizationId }, consent));
  assert.equal(duplicate.txHash, sent.txHash, "Duplicate local wallet POST must not create another mint transaction");
  // Deliberately omit the browser's advisory /transactions report. The local
  // broadcast route and reconciler must still discover/promote the actual event.
  await waitForStatus(signatureId, (status) => status.state === "finalized");
  const minted = await verifyProjection(signatureId);
  assert.equal(minted.txHash, sent.txHash);
  assert.equal(getAddress(minted.currentTokenHolder), LOCAL_TEST_WALLET);
  assert.equal(await chain.readContract({ address: runtime.contract, abi: tokenAbi, functionName: "tokenURI", args: [BigInt(minted.tokenId)] }), authorization.tokenURI);
  console.log(`Mint automatically indexed: ${sent.txHash}`);

  const transferred = await json<{ txHash: Hex }>(await postJson("/api/local/wallet/transfer", { signatureId }));
  await waitForStatus(signatureId, (status) => getAddress(status.currentTokenHolder) === LOCAL_TEST_RECIPIENT);
  const final = await verifyProjection(signatureId);
  const transferReceipt = await chain.getTransactionReceipt({ hash: transferred.txHash });
  assert.equal(transferReceipt.status, "success");
  const me = await (await request("/me")).text();
  assert(me.includes(signatureId), "A transfer must not remove the original claimant's collection entry");
  const svgAfter = Buffer.from(await (await request(`/artifacts/${signatureId}.svg`)).arrayBuffer());
  assert.deepEqual(svgAfter, svgBefore, "Minting and transferring must not alter the canonical artwork");
  console.log(JSON.stringify({ passed: true, mode: "local-interactive-http", signatureId, gr0k, tokenId: final.tokenId, mintTransaction: sent.txHash, transferTransaction: transferred.txHash, currentHolder: final.currentTokenHolder, finality: final.finality, claimPreserved: true, artworkUnchanged: true }));
}
