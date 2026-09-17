import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, stringToHex } from "viem";
import { MBTI_TYPES, RENDERER_VERSION, type MBTI } from "../algorithmV2/index.js";
import { sha256Hex } from "../v1/renderer.js";
import { AssessmentCoordinator, type AssessmentProvider, type AssessmentRepository } from "./assessment.js";
import { FileAssessmentRepository, MemoryAssessmentRepository } from "./assessmentStore.js";
import type { OpenMintNetwork } from "./network.js";
import { WalletSessions } from "./security.js";
import { OpenMintService } from "./service.js";
import { FileKeyValueStore, MemoryKeyValueStore, type KeyValueStore } from "./storage.js";
import { DevelopmentXIdentityResolver } from "./xIdentity.js";

// Unlike the fast service suite, these tests run the actual SVG -> sharp -> PNG
// pipeline. The SVG expectation comes from the independently generated Python oracle.
const goldens = JSON.parse(readFileSync(new URL("../../reference/algorithm-v2.0.0/golden-svgs.json", import.meta.url), "utf8")) as {
  handle: string; mbti: MBTI; width: number; height: number; sha256: string;
}[];
const HANDLE = "Alice_Bob_Key";
const NOW = 1_800_000_000_000;
const ORIGIN = "https://signatures.example";
const WALLET = getAddress(`0x${"1".repeat(40)}`);

function setup(mbti: MBTI, store: KeyValueStore = new MemoryKeyValueStore(), repository: AssessmentRepository = new MemoryAssessmentRepository()) {
  const provider: AssessmentProvider = {
    provenance: "development-fixture", model: "development-fixture-v1",
    assess: vi.fn(async (handle, identity) => ({ handle, mbti, model: "development-fixture-v1", providerResponseId: `development-fixture:${handle}`, sourceUrls: [], xUserId: identity!.userId })),
  };
  const sessions = new WalletSessions(ORIGIN, 31337, () => NOW);
  const session = sessions.session().session;
  session.wallet = WALLET;
  session.walletProof = { wallet: WALLET, expiresAt: NOW + 600_000 };
  const network: OpenMintNetwork = {
    chainId: 31337, address: WALLET, authorizer: WALLET,
    now: async () => NOW / 1000,
    state: vi.fn(async () => ({ state: "unminted" as const })),
    sign: vi.fn(async () => { throw new Error("Rendering must not sign a mint"); }),
    transaction: vi.fn(async () => { throw new Error("Rendering must not submit a mint"); }),
  };
  const service = new OpenMintService({
    assessments: new AssessmentCoordinator({ provider, repository, identityResolver: new DevelopmentXIdentityResolver({ [HANDLE.toLowerCase()]: HANDLE }, () => new Date(NOW)), now: () => new Date(NOW) }),
    store, network, origin: ORIGIN, fixture: true, now: () => NOW,
  });
  return { service, session, provider, network };
}

describe("native MBTI artifact rendering integration", () => {
  it.each(MBTI_TYPES)("commits real SVG, opaque PNG, and native metadata for %s", async mbti => {
    const { service, session, provider, network } = setup(mbti);
    const request = await service.request(HANDLE.toLowerCase(), session);
    await service.idle();
    expect(await service.getRequest(request.code)).toMatchObject({ status: "ready", requestedHandle: HANDLE.toLowerCase() });
    const artifact = (await service.artifact(HANDLE))!;
    const svg = (await service.asset(artifact.svgSha256, "svg"))!;
    const png = (await service.asset(artifact.pngSha256, "png"))!;
    const metadataBytes = (await service.asset(artifact.metadataSha256, "json"))!;
    const oracle = goldens.find(item => item.handle === HANDLE && item.mbti === mbti && item.width === 1080 && item.height === 1080)!;
    expect(oracle).toBeDefined();
    expect(sha256Hex(svg)).toBe(oracle.sha256);
    expect(artifact.svgSha256).toBe(oracle.sha256);
    expect(sha256Hex(png)).toBe(artifact.pngSha256);
    expect(sha256Hex(metadataBytes)).toBe(artifact.metadataSha256);
    expect(svg.toString()).toContain(`>@${HANDLE}</text>`);
    expect((await sharp(png).metadata())).toMatchObject({ format: "png", width: 1080, height: 1080 });

    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = mbti.startsWith("I") ? [0, 0, 0] : [244, 231, 199];
    expect([...data.subarray(0, 4)]).toEqual([...background, 255]);
    let inkPixels = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset + 3] !== 255) throw new Error(`Unexpected transparent pixel at ${x},${y}`);
      // Exclude the bottom label so a blank signature with a valid label fails.
      if (y < 900 && data[offset] !== background[0]) inkPixels++;
    }
    expect(inkPixels).toBeGreaterThan(100);

    const metadata = JSON.parse(metadataBytes.toString());
    expect(metadata).toMatchObject({
      name: `@${HANDLE} · ${mbti}`,
      image: `${ORIGIN}/artifacts/${artifact.pngSha256}.png`,
      animation_url: `${ORIGIN}/artifacts/${artifact.svgSha256}.svg`,
      external_url: `${ORIGIN}/signatures/${HANDLE.toLowerCase()}`,
      assessment: { rendererVersion: RENDERER_VERSION, mbti },
      attributes: [{ trait_type: "Handle", value: HANDLE }, { trait_type: "MBTI", value: mbti }],
    });
    expect(metadata.renderer).toEqual({ version: RENDERER_VERSION, handle: HANDLE, mbti, svgSha256: artifact.svgSha256, pngSha256: artifact.pngSha256 });
    expect(metadata.assessment).not.toHaveProperty("seed");
    expect(metadata.assessment).not.toHaveProperty("mappingVersion");
    const { digest, ...unsigned } = artifact;
    expect(digest).toBe(keccak256(stringToHex(JSON.stringify(unsigned))));
    expect(artifact.tokenURI).toBe(`${ORIGIN}/artifacts/${artifact.metadataSha256}.json`);
    expect(provider.assess).toHaveBeenCalledTimes(1);
    expect(provider.assess).toHaveBeenCalledWith(HANDLE.toLowerCase(), artifact.assessment.xIdentity);
    expect(artifact.assessment.xIdentity?.provenance).toBe("development-fixture");
    expect(network.sign).not.toHaveBeenCalled();
    expect(network.transaction).not.toHaveBeenCalled();
  });

  it("reopens persisted PNG/SVG bytes without re-assessment or changing first-render casing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sg-native-artifacts-test-"));
    try {
      const storePath = join(directory, "state");
      const assessmentPath = join(directory, "assessments");
      const original = setup("INFP", await FileKeyValueStore.create(storePath), new FileAssessmentRepository(assessmentPath));
      await original.service.request(HANDLE, original.session); await original.service.idle();
      const before = (await original.service.artifact(HANDLE))!;
      const extensions = ["svg", "png", "json"] as const;
      const hashes = [before.svgSha256, before.pngSha256, before.metadataSha256];
      const bytes = await Promise.all(hashes.map((hash, index) => original.service.asset(hash, extensions[index])));

      // A new provider would choose a different MBTI; the persisted canonical one wins.
      const restarted = setup("ESTJ", await FileKeyValueStore.create(storePath), new FileAssessmentRepository(assessmentPath));
      const next = await restarted.service.request(HANDLE.toUpperCase(), restarted.session);
      await restarted.service.idle();
      expect(await restarted.service.getRequest(next.code)).toMatchObject({ status: "ready", assessmentId: before.assessment.id });
      expect(await restarted.service.artifact(HANDLE.toLowerCase())).toEqual(before);
      for (const [index, hash] of hashes.entries()) expect(await restarted.service.asset(hash, extensions[index])).toEqual(bytes[index]);
      expect(restarted.provider.assess).not.toHaveBeenCalled();
      expect(restarted.network.sign).not.toHaveBeenCalled();
      expect(restarted.network.transaction).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
