import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("./002_v2_minting.sql", import.meta.url), "utf8");

function functionBody(name: string): string {
  const match = sql.match(new RegExp(
    `CREATE OR REPLACE FUNCTION ${name}\\([^]*?\\n\\$\\$;`,
  ));
  if (!match) throw new Error(`Missing SQL function ${name}.`);
  return match[0];
}

describe("V2 migration lifecycle fences", () => {
  it("serializes every binding mutation and rejects unresolved authority", () => {
    const head = functionBody("v2_validate_wallet_binding_head");
    const binding = functionBody("v2_guard_wallet_binding");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OR DELETE ON wallet_binding_heads");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OR DELETE ON wallet_bindings");
    expect(head).toContain("v2_binding_guard_has_unresolved_authority");
    expect(head).toContain("wallet binding head cannot change while mint authority is unresolved");
    expect(binding).toContain("FROM wallet_binding_heads");
    expect(binding).toContain("FOR UPDATE");
    expect(binding).toContain("new wallet binding cannot activate while mint authority is unresolved");
    expect(binding).toContain("wallet binding cannot end while mint authority is unresolved");
    expect(sql).toContain("wallet_bindings_validate_activation_commit");
    expect(functionBody("v2_validate_wallet_binding_activation_commit")).toContain(
      "active wallet binding must be the versioned binding head",
    );
  });

  it("has an immediate unresolved slot and a conflicting-wallet exclusion", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX mint_authorizations_one_unresolved_binding_slot[\s\S]*?ON mint_authorizations \(signature_id, deployment_id, wallet_binding_id\)[\s\S]*?WHERE issuance_state <> 'signing_failed'[\s\S]*?expired_unconsumed/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX mint_authorizations_no_conflicting_wallet_slot[\s\S]*?ON mint_authorizations \(signature_id, deployment_id\)[\s\S]*?WHERE issuance_state <> 'signing_failed'[\s\S]*?expired_unconsumed/,
    );
    const commit = functionBody("v2_validate_mint_authorization_commit");
    expect(commit).toContain("FROM wallet_binding_heads");
    expect(commit).toContain("FOR UPDATE");
  });

  it("requires finalized chain coverage and a pinned unused-state read for expiry", () => {
    const expiry = functionBody("v2_has_finalized_expiry_evidence");
    expect(sql).toContain("terminal_evidence_kind = 'expired_unconsumed'");
    expect(sql).toContain("mint_authorizations_terminal_evidence_block_fk");
    expect(expiry).toContain("terminal_evidence_authorization_state = 0");
    expect(expiry).toContain("terminal_evidence_minted_signature = FALSE");
    expect(expiry).toContain("terminal_evidence_primary_hash");
    expect(expiry).toContain("terminal_evidence_secondary_hash");
    expect(expiry).toContain("block.block_timestamp > authorization_row.deadline");
    expect(expiry).toContain("checkpoint.promoted_finalized_height >= block.block_number");
    expect(expiry).toContain("block.canonical");
    expect(expiry).toContain("block.finalized");
    expect(expiry).toContain("NOT EXISTS");
  });

  it("cannot mark final consumption or revocation without matching immutable evidence", () => {
    const authorization = functionBody("v2_guard_mint_authorization");
    const consumed = functionBody("v2_has_finalized_consumption_evidence");
    const revoked = functionBody("v2_has_finalized_revocation_evidence");
    expect(authorization).toContain("consumed_finalized requires a finalized validated mint event and receipt");
    expect(authorization).toContain("revoked_finalized requires a finalized validated revocation event");
    expect(authorization).toContain("expired_unconsumed requires finalized coverage and a pinned unused-state read");
    expect(authorization).toContain("signing_failed requires durable proof that no signature was released");
    for (const evidence of [consumed, revoked]) {
      expect(evidence).toContain("event.validation_state = 'validated'");
      expect(evidence).toContain("event.finality_state = 'finalized'");
      expect(evidence).toContain("receipt.finalized");
      expect(evidence).toContain("block.finalized");
    }
    expect(revoked).toContain("event.event_kind = 'authorization_revoked'");
    expect(revoked).toContain("event.event_kind = 'authorizer_epoch_revoked'");
  });

  it("permits controlled deletion only after the same safely-dead predicate", () => {
    expect(functionBody("v2_guard_mint_authorization")).toContain(
      "IF NOT v2_authorization_is_safely_dead(OLD)",
    );
    expect(functionBody("v2_guard_mint_attempt_delete")).toContain(
      "IF NOT v2_authorization_is_safely_dead(authorization_row)",
    );
    expect(functionBody("v2_guard_v1_signature_erasure")).toContain(
      "NOT v2_authorization_is_safely_dead(mint_auth)",
    );
    expect(sql).toContain("CREATE TABLE signature_erasure_chain_evidence");
    const erasureEvidence = functionBody("v2_guard_signature_erasure_chain_evidence");
    expect(erasureEvidence).toContain("block.block_timestamp > NEW.covered_through_deadline");
    expect(erasureEvidence).toContain("checkpoint.promoted_finalized_height >= block.block_number");
    expect(erasureEvidence).toContain("NOT v2_authorization_is_safely_dead(mint_auth)");
    expect(functionBody("v2_guard_mint_authorization")).toContain(
      "v2_has_signature_erasure_chain_evidence",
    );
  });

  it("drains exact V2 metadata references and writers before deleting frozen receipts", () => {
    const metadata = functionBody("v2_guard_token_metadata");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION v2_token_metadata_reference_id");
    expect(metadata).toContain("OLD.preparation_state NOT IN ('aborted', 'frozen')");
    expect(metadata).toContain("OLD.lease_owner IS NOT NULL");
    expect(metadata).toContain("FROM content_object_guards guard");
    expect(metadata).toContain("ORDER BY guard.storage_target_id, guard.object_key");
    expect(metadata).toContain("FOR UPDATE");
    for (const kind of ["v2_svg_pin", "v2_png_pin", "v2_metadata_pin"]) {
      expect(metadata).toContain(`reference.reference_kind = '${kind}'`);
      expect(metadata).toContain(`'${kind}'`);
    }
    for (const key of ["OLD.svg_cid", "OLD.png_cid", "OLD.metadata_cid",
      "OLD.canonical_json_storage_key"]) {
      expect(metadata).toContain(key);
    }
    expect(metadata).toContain("lease.state = 'writing'");
    expect(metadata).toContain("V2 metadata content references must be detached before deletion");
    expect(metadata).toContain("V2 metadata content writers must be drained before deletion");
    expect(metadata).toContain("pin_provider_receipts` remains immutable evidence");
  });

  it("binds each V2 content reference to its exact live metadata owner and object", () => {
    const lease = functionBody("v2_guard_content_write_lease");
    const immediateReference = functionBody("v2_guard_content_reference_write");
    const reference = functionBody("v2_validate_content_reference_commit");
    for (const authorityColumn of [
      "control_signature_id",
      "control_version",
      "metadata_deployment_id",
      "metadata_fencing_token",
      "metadata_lease_owner",
    ]) {
      expect(sql).toContain(authorityColumn);
      expect(reference).toContain(`lease_row.${authorityColumn}`);
    }
    expect(lease).toContain("control_row.issuance_state <> 'enabled'");
    expect(lease).toContain("control_row.version <> NEW.control_version");
    expect(lease).toContain("metadata_row.preparation_state <> 'publishing'");
    expect(lease).toContain("metadata_row.fencing_token <> NEW.metadata_fencing_token");
    expect(lease).toContain("metadata_row.lease_owner IS DISTINCT FROM NEW.metadata_lease_owner");
    expect(lease).toContain("metadata_row.lease_expires_at <= now()");
    expect(lease).toContain("NEW.state = 'committed' AND guard_row.state <> 'present'");
    expect(immediateReference).toContain("metadata_row.preparation_state <> 'publishing'");
    expect(immediateReference).toContain("V2 content reference requires the live metadata-preparation owner and fence");
    expect(reference).toContain("IF NEW.reference_kind IN ('v1_svg', 'v1_png')");
    expect(reference).toContain("FROM token_metadata metadata");
    expect(reference).toContain("v2_token_metadata_reference_id");
    expect(reference).toContain("NEW.object_key = metadata_row.svg_cid");
    expect(reference).toContain("NEW.object_key = metadata_row.png_cid");
    expect(reference).toContain("metadata_row.metadata_cid, metadata_row.canonical_json_storage_key");
    expect(reference).toContain("FOR UPDATE");
    expect(reference).toContain("metadata_row.preparation_state NOT IN ('publishing', 'verified', 'frozen')");
    expect(reference).toContain(
      "V2 content reference lost its metadata-preparation fence before commit",
    );
    expect(sql).toContain("SET CONSTRAINTS content_object_references_validate_commit IMMEDIATE");
    expect(sql).toContain("SET CONSTRAINTS content_object_references_validate_commit DEFERRED");
    expect(sql).toContain("object guard remains shared");
  });

  it("rejects publication unless the exact deployment projection is still finalized", () => {
    const outboxWrite = functionBody("v2_guard_gallery_outbox_insert");
    const outbox = functionBody("v2_validate_gallery_publish_outbox_commit");
    const lease = functionBody("v2_guard_publication_lease");
    expect(sql).toContain("BEFORE INSERT OR UPDATE ON gallery_publication_outbox");
    expect(outboxWrite).toContain("NEW.signature_id, NEW.deployment_id, NEW.action");
    expect(outboxWrite).toContain("NEW.observed_control_version, NEW.payload, NEW.created_at");
    expect(outboxWrite).toContain("gallery outbox identity, action, authority, and payload are immutable");
    expect(sql).toContain("gallery_publication_outbox_validate_finality_commit");
    expect(sql).toMatch(
      /CREATE CONSTRAINT TRIGGER gallery_publication_outbox_validate_finality_commit[\s\S]*?AFTER INSERT OR UPDATE[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
    );
    for (const body of [outbox, lease]) {
      expect(body).toContain("entry.signature_id = NEW.signature_id");
      expect(body).toContain("entry.deployment_id = NEW.deployment_id");
      expect(body).toContain("entry.chain_state = 'finalized'");
      expect(body).toContain("FOR SHARE");
    }
    expect(outbox).toContain("control_row.issuance_state <> 'enabled'");
    expect(outbox).toContain("control_row.version <> NEW.observed_control_version");
    expect(outbox).toContain("FROM gallery_suppressions");
    expect(outbox).toContain("publish outbox item requires an exact finalized Gallery entry");
    expect(lease).toContain("NEW.state IN ('staging', 'ready', 'activated')");
    expect(lease).toContain("publication lease requires an exact finalized Gallery entry");
  });
});

describe("V2 migration append-only chain evidence", () => {
  it.each([
    ["chain_blocks", "v2_guard_chain_block_observation"],
    ["transaction_receipt_observations", "v2_guard_receipt_observation"],
    ["contract_log_observations", "v2_guard_contract_log_observation"],
    ["gallery_entries", "v2_guard_gallery_entry"],
  ] as const)("guards inserts/updates/deletes for %s", (table, guard) => {
    expect(sql).toContain(`BEFORE INSERT OR UPDATE OR DELETE ON ${table}`);
    expect(functionBody(guard)).toMatch(/TG_OP = 'DELETE'/);
  });

  it("freezes block and receipt payloads and forbids finalized rewrites", () => {
    const blocks = functionBody("v2_guard_chain_block_observation");
    const receipts = functionBody("v2_guard_receipt_observation");
    expect(blocks).toContain("IF TG_OP = 'INSERT' THEN");
    expect(blocks).toContain("chain block observation must begin unfinalized");
    expect(blocks).toContain("chain block observation identity and payload are immutable");
    expect(blocks).toContain("finalized chain block evidence is immutable");
    expect(receipts).toContain("transaction receipt observation identity and payload are immutable");
    expect(receipts).toContain("finalized transaction receipt evidence is immutable");
    expect(receipts).toContain("finalized receipt requires finalized canonical block evidence");
  });

  it("freezes decoded log payloads and requires block plus receipt finality", () => {
    const logs = functionBody("v2_guard_contract_log_observation");
    expect(logs).toContain("contract log observation identity and decoded payload are immutable");
    expect(logs).toContain("contract log observation must begin unfinalized");
    expect(logs).toContain("finalized log requires finalized canonical block, receipt, and validation evidence");
    expect(logs).toContain("only a previously finalized log may become finality_revoked");
  });

  it("keeps finalized Gallery provenance and permits only explicit finality revocation", () => {
    const gallery = functionBody("v2_guard_gallery_entry");
    expect(gallery).toContain("gallery entry must begin from finalized chain state");
    expect(gallery).toContain("finalized Gallery provenance cannot be deleted");
    expect(gallery).toContain("Gallery mint provenance is immutable");
    expect(gallery).toContain("finality-revoked Gallery provenance is terminal");
  });

  it("retains balanced function bodies and one transactional migration envelope", () => {
    expect(sql.match(/\$\$/g)?.length ?? 0).toBeGreaterThan(0);
    expect((sql.match(/\$\$/g)?.length ?? 0) % 2).toBe(0);
    expect((sql.match(/^BEGIN;$/gm) ?? [])).toHaveLength(1);
    expect((sql.match(/^COMMIT;$/gm) ?? [])).toHaveLength(1);
  });
});
