import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Mutates ONLY an explicitly labelled fixture app's isolated local Anvil.
if (!process.argv.includes("--execute-local-test-transactions")) throw new Error("Pass --execute-local-test-transactions to create an assessment and mint on the isolated fixture chain.");
const origin = process.env.OPEN_MINT_TEST_ORIGIN ?? "http://127.0.0.1:3002";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Rehearsal requires a literal loopback origin.");
const home = await fetch(origin);
const html = await home.text();
assert.equal(home.status, 200);
assert.ok(html.includes('data-fixture="true"') && html.includes('data-local-chain="true"'), "Refuse anything except explicit fixture+local-chain mode.");
const cookie = home.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
const session = await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json();
const headers = { cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken };
const post = async (path, body, expected = 200) => {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
};
const handle = `check_${randomBytes(3).toString("hex")}`;
await post("/api/assessments", { handle, mbti: "INTJ" }, 400);
await post("/api/assessments", { handle }, 403);
const preview = await fetch(`${origin}/s/${handle}/ENFP`);
assert.equal(preview.status, 200);
assert.ok((await preview.text()).includes(`/mint?handle=${handle}`));
const wallet = await post("/api/dev/wallet", {});
const { url } = await post("/api/assessments", { handle }, 202);
assert.ok(url.startsWith('/mint/'));
const code = url.split("/").at(-1);
let assessment;
for (let attempt = 0; attempt < 30; attempt++) {
  assessment = await (await fetch(`${origin}/api/assessments/${code}`, { headers: { cookie } })).json();
  if (assessment.status !== "pending") break;
  await new Promise(resolve => setTimeout(resolve, 300));
}
assert.equal(assessment.status, "ready", JSON.stringify(assessment));
for (const field of ['mbti', 'imageUrl', 'svgUrl', 'svgSha256', 'pngSha256']) assert.equal(Object.hasOwn(assessment, field), false, `Must not reveal ${field} before minting.`);
assert.equal((await fetch(`${origin}/api/assessments/${code}`)).status, 403);
assert.equal((await fetch(`${origin}/signatures/${handle}`)).status, 404);
await post("/api/dev/mint", { code, consent: false }, 400);
const { transactionHash } = await post("/api/dev/mint", { code, consent: true });
let mint;
for (let attempt = 0; attempt < 30; attempt++) {
  mint = await (await fetch(`${origin}/api/mints/status/${code}`, { headers: { cookie } })).json();
  if (mint.state === "minted") break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(mint.state, "minted", JSON.stringify(mint));
assert.equal(mint.wallet.toLowerCase(), wallet.wallet.toLowerCase());
assert.equal(mint.transactionHash, transactionHash);
await post("/api/dev/mint", { code, consent: true }, 409);
const collection = await (await fetch(`${origin}/me`, { headers: { cookie } })).text();
assert.ok(collection.includes(`/signatures/${handle}`), "Minted token must appear in wallet collection.");
const permalink = `/signatures/${handle}`;
assert.equal((await fetch(`${origin}${permalink}`)).status, 200);
assessment = await (await fetch(`${origin}/api/assessments/${code}`, { headers: { cookie } })).json();
assert.ok(assessment.mbti && assessment.imageUrl, 'Confirmed mint reveals the final result.');
await post('/api/assessments', { handle }, 409);
const image = await fetch(`${origin}${assessment.imageUrl}`);
assert.equal(image.status, 200);
assert.equal(image.headers.get("content-type"), "image/png");
console.log(JSON.stringify({ ok: true, origin, handle, mbti: assessment.mbti, tokenId: mint.tokenId, transactionHash, wallet: mint.wallet, permalink, checks: ["editable preview bridge", "forged MBTI rejected", "wallet proof before assessment", "private mint request", "no result before confirmation", "explicit consent required", "actual local mint", "duplicate mint rejected before assessment", "wallet collection", "immutable artwork asset"] }, null, 2));
