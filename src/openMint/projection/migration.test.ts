import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectionRpcFixture } from "../fixtures/projectionRpc.js";
import { disposablePostgres, installSchema } from "../persistence/fixtures/postgres.js";
import { ExclusiveWriter } from "../persistence/writer.js";
import { OpenMintProjection } from "./postgres.js";
import { stable } from "./model.js";

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("explicit projection v1 → v2 upgrade", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter;
  const migration = readFileSync(new URL("projection-v2.sql", import.meta.url), "utf8");
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = new Client(cluster.config); await admin.connect(); await installSchema(admin);
    await admin.query(readFileSync(new URL("projection-schema.sql", import.meta.url), "utf8"));
  }, 30000);
  afterAll(async () => { await writer?.close(); await admin?.end(); cluster?.stop(); });
  it("refuses the old schema, preserves saved v1 data, and never reruns an already-applied migration", async () => {
    const { options: { deployment } } = await projectionRpcFixture();
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'local-fixture','development-fixture','test')", [deployment.namespaceId]);
    const configuration = Buffer.from(stable(deployment));
    await admin.query("INSERT INTO open_mint.projection_deployments VALUES($1,$2,$3)", [deployment.id, deployment.namespaceId, configuration]);
    writer = await ExclusiveWriter.acquire(() => new Client(cluster.config));
    await expect(OpenMintProjection.open(writer, deployment)).rejects.toThrow("Unsupported projection schema");
    expect((await admin.query("SELECT version FROM open_mint.projection_schema_version")).rows).toEqual([{ version: 1 }]);
    await writer.close(); // The operator, never startup, applies the explicit upgrade.
    await admin.query(migration);
    expect((await admin.query("SELECT version FROM open_mint.projection_schema_version")).rows).toEqual([{ version: 2 }]);
    expect((await admin.query("SELECT configuration FROM open_mint.projection_deployments WHERE deployment_id=$1", [deployment.id])).rows[0].configuration).toEqual(configuration);
    writer = await ExclusiveWriter.acquire(() => new Client(cluster.config));
    expect(await (await OpenMintProjection.open(writer, deployment)).checkpoint()).toMatchObject({ health: "unknown", freshChainVerified: false });
    await writer.close();
    await expect(admin.query(migration)).rejects.toMatchObject({ code: "55000" }); await admin.query("ROLLBACK");
    expect((await admin.query("SELECT version FROM open_mint.projection_schema_version")).rows).toEqual([{ version: 2 }]);
  });
});
