import { resolve, join } from "node:path";
import { AssessmentCoordinator } from "./assessment.js";
import { FileAssessmentRepository } from "./assessmentStore.js";
import { DevelopmentAssessmentProvider, GrokAssessmentProvider } from "./grok.js";
import { acquireProcessLock, FileKeyValueStore } from "./storage.js";
import { WalletSessions } from "./security.js";
import { OpenMintService } from "./service.js";
import { createOpenMintServer } from "./server.js";
import { localTestMinter, startIsolatedLocalChain } from "./localChain.js";
import { closeHttpServer } from "./shutdown.js";
import { DevelopmentXIdentityResolver, XApiIdentityResolver } from "./xIdentity.js";
import { AssessmentOperations } from "./assessmentOperations.js";
import { FIXTURE_PROFILE_VERSION, generationPolicy, GROK_PILOT_PROFILE } from "./providerProfile.js";
import { openMintSupportUrl } from "./supportUrl.js";

/** Configuration only; constructing providers performs no X or Grok requests. */
export function openMintProviders(fixture: boolean, env: NodeJS.ProcessEnv) {
  generationPolicy(fixture, env);
  const provider = fixture ? new DevelopmentAssessmentProvider() : env.XAI_API_KEY ? new GrokAssessmentProvider({ apiKey: env.XAI_API_KEY, profile: GROK_PILOT_PROFILE }) : undefined;
  const identityResolver = fixture ? new DevelopmentXIdentityResolver() : env.OPEN_MINT_X_BEARER_TOKEN ? new XApiIdentityResolver({ bearerToken: env.OPEN_MINT_X_BEARER_TOKEN }) : undefined;
  return { provider, identityResolver };
}

export async function startOpenMintApp() {
  if (process.env.NODE_ENV === "production") throw new Error("Production startup refused: open mint requires public artifact publication, production persistence/rate limits, a reviewed deployment and external security review. The current chain adapter is local only.");
  const fixture = process.argv.includes("--fixture");
  const localChain = process.argv.includes("--local-chain");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PORT.");
  const origin = process.env.OPEN_MINT_ORIGIN ?? `http://127.0.0.1:${port}`;
  if (origin !== `http://127.0.0.1:${port}`) throw new Error("Local open mint requires OPEN_MINT_ORIGIN to match its literal loopback port.");
  const root = resolve(process.env.OPEN_MINT_DATA_DIR ?? `.local/open-mint/${fixture ? "fixture" : "grok"}`);
  if (!root.startsWith(`${resolve(".local/open-mint")}/`)) throw new Error("Open-mint data must use a dedicated directory under .local/open-mint/.");
  const policy = generationPolicy(fixture, process.env);
  const supportUrl = openMintSupportUrl(process.env.OPEN_MINT_SUPPORT_URL);
  const { provider, identityResolver } = openMintProviders(fixture, process.env);
  const unlock = await acquireProcessLock(root);
  let chain: Awaited<ReturnType<typeof startIsolatedLocalChain>> | undefined;
  try {
    if (localChain) chain = await startIsolatedLocalChain({ directory: join(root, "chain"), port: Number(process.env.OPEN_MINT_RPC_PORT ?? (fixture ? 18547 : 18546)), origin, fixture });
    // Reading frozen results is independent from possessing paid-generation credentials.
    const assessments = new AssessmentCoordinator({ provider, identityResolver, expectedProvenance: fixture ? "development-fixture" : "grok", repository: new FileAssessmentRepository(join(root, "assessments")) });
    const store = await FileKeyValueStore.create(join(root, "records"));
    const operations = new AssessmentOperations({ ...policy, store, generationEnabled: () => fixture || generationPolicy(false, process.env).enabled });
    const service = new OpenMintService({ assessments, store, origin, network: chain?.network, fixture, operations,
      assessmentProfileVersion: fixture ? FIXTURE_PROFILE_VERSION : GROK_PILOT_PROFILE.id });
    await service.recoverInterruptedRequests();
    const sessions = new WalletSessions(origin, 31337);
    const server = createOpenMintServer({ origin, fixture, service, sessions, rpcUrl: chain?.rpcUrl, supportUrl,
      ...(chain ? {
        devWallet: async (session, code) => {
          const challenge = sessions.challenge(session, localTestMinter().address, code);
          const signature = await localTestMinter().signMessage({ message: challenge.message });
          return sessions.verify(session, challenge.challengeId, signature);
        },
        devMint: async (session, code, consent) => {
          const result = await service.authorize(code, consent, session);
          if (result.transaction.from.toLowerCase() !== localTestMinter().address.toLowerCase()) throw new Error("Select the local test wallet before using the developer mint control.");
          const transactionHash = await chain!.send(result.transaction);
          await service.report(code, transactionHash, session);
          return { transactionHash };
        },
      } : {}),
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      await closeHttpServer(server);
      await service.idle(); await chain?.close(); await unlock();
    })();
    process.once("SIGTERM", () => { void close(); });
    process.once("SIGINT", () => { void close(); });
    console.log(`Open-mint development app: ${origin}`);
    console.log(`Assessment: ${fixture ? "EXPLICIT DEVELOPMENT FIXTURE (not Grok)" : provider ? "backend Grok + native X Search" : "disabled — XAI_API_KEY is not configured"}`);
    console.log(`New generation: ${policy.enabled ? "enabled within the configured admission limits" : "disabled; saved assessment recovery remains available"}`);
    console.log(`X username verification: ${fixture ? "EXPLICIT DEVELOPMENT FIXTURE (not X verification)" : identityResolver ? "X API username lookup at first preparation; frozen snapshot reused" : "disabled — OPEN_MINT_X_BEARER_TOKEN is not configured; new real preparation is blocked"}`);
    console.log(`Minting: ${chain ? `isolated local Anvil ${chain.rpcUrl}` : "disabled — start with --local-chain"}`);
    return { server, service, sessions, chain, close, origin };
  } catch (error) { await chain?.close(); await unlock(); throw error; }
}
