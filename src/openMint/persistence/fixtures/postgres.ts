import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Client, type ClientConfig } from "pg";

/** Deliberately cannot accept a DATABASE_URL or existing data directory.
 * No TCP listener, credentials, application database, or existing service used.
 */
export function disposablePostgres(): { config: ClientConfig; stop(): void } {
  const root = mkdtempSync("/tmp/sg-open-mint-pg-");
  const data = resolve(root, "data"), socket = resolve(root, "socket");
  const bin = process.env.OPEN_MINT_TEST_POSTGRES_BIN;
  const binary = (name: string) => bin ? resolve(bin, name) : name;
  const run = (name: string, args: string[]) => execFileSync(binary(name), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  const stop = () => {
    if (started) {
      const stopped = spawnSync(binary("pg_ctl"), ["-D", data, "-m", "fast", "-t", "15", "stop", "-w"], { encoding: "utf8" });
      if (stopped.status !== 0) throw new Error(`Failed to stop disposable cluster: ${root}`);
      started = false;
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(socket);
    run("initdb", ["-D", data, "--username=open_mint_test", "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--no-locale", "--no-instructions"]);
    run("pg_ctl", ["-D", data, "-l", resolve(root, "postgres.log"), "-o", `-h '' -k ${socket} -c listen_addresses='' -c unix_socket_permissions=0700`, "-t", "15", "start", "-w"]);
    started = true;
    return { config: { host: socket, database: "postgres", user: "open_mint_test", connectionTimeoutMillis: 3000, statement_timeout: 3000 }, stop };
  } catch (error) { stop(); throw error; }
}
export async function installSchema(client: Client): Promise<void> {
  await client.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
}
