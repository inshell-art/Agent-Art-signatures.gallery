/** Exact shared foundation surface. Audit and grant generation must agree;
 * extensions require a separate, reviewed capability profile. */
export const FOUNDATION_RUNTIME_PRIVILEGES = Object.freeze(([
  ["schema_version", "version", false, ""],
  ["writer_epoch", "singleton epoch", false, "epoch"],
  ["namespaces", "namespace_id profile provenance policy_version", false, ""],
  ["budget_policies", "namespace_id profile_version expected_model generation_enabled valid_until max_total max_daily max_active max_queued reservation_usd_ticks max_exposure_usd_ticks", false, "namespace_id"],
  ["handle_guards", "namespace_id handle", true, "handle"],
  ["assessment_attempts", "namespace_id attempt_id handle record_version profile_version admitted_at state", true, "state"],
  ["assessment_terminals", "namespace_id attempt_id kind reason phase owner_epoch recorded_at", true, ""],
  ["budget_reservations", "namespace_id attempt_id admitted_day reserved_usd_ticks", true, ""],
  ["jobs", "namespace_id job_id attempt_id kind state owner_epoch", true, "state owner_epoch"],
  ["dispatch_fences", "namespace_id attempt_id leg owner_epoch dispatched_at", true, ""],
  ["provider_receipts", "namespace_id attempt_id leg record_version payload cost_status cost_usd_ticks", true, ""],
  ["verified_identities", "namespace_id attempt_id payload", true, ""],
  ["assessments", "namespace_id handle assessment_id attempt_id digest payload", true, ""],
  ["session_profiles", "namespace_id origin chain_id", false, ""],
  ["sessions", "namespace_id session_hash csrf expires_at generation revoked wallet proof_wallet proof_code_hash proof_expires_at active_challenge_hash", true,
    "generation revoked wallet proof_wallet proof_code_hash proof_expires_at active_challenge_hash"],
  ["wallet_challenges", "namespace_id challenge_hash session_hash generation message wallet code_hash expires_at consumed_at", true, "consumed_at"],
] as const).map(([name, columns, insert, updates]) => Object.freeze({ name, columns: Object.freeze(columns.split(" ").sort()), insert,
  updates: Object.freeze(updates ? updates.split(" ") : []) })));

/** Reviewed grant template for the foundation schema only. Returns SQL; never
 * creates a role, opens a connection, applies a migration, or grants ownership.
 * Request/publication/issuance/projection extensions need separately reviewed
 * grants before use. Run as a migration owner against an explicit database. */
export function foundationRuntimeGrants(role: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role) || role.startsWith("pg_") || role === "public") throw new Error("Invalid dedicated runtime role.");
  const target = `"${role}"`;
  return [
    `GRANT USAGE ON SCHEMA open_mint TO ${target};`,
    `GRANT SELECT ON ${FOUNDATION_RUNTIME_PRIVILEGES.map(table => `open_mint.${table.name}`).join(", ")} TO ${target};`,
    `GRANT INSERT ON ${FOUNDATION_RUNTIME_PRIVILEGES.filter(table => table.insert).map(table => `open_mint.${table.name}`).join(", ")} TO ${target};`,
    // PostgreSQL SELECT FOR UPDATE requires UPDATE on at least one column.
    // Permit only an immutable key, never the operator's generation switch.
    ...FOUNDATION_RUNTIME_PRIVILEGES.filter(table => table.updates.length).map(table => `GRANT UPDATE (${table.updates.join(", ")}) ON open_mint.${table.name} TO ${target};`),
  ].join("\n");
}
