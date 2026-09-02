/**
 * HTML page templating for the cluster and verification routes (§9.2,
 * §9.4). Both routes still serve JSON to a client that asks for it via
 * `Accept: application/json` (see `wantsJson` in server.ts); HTML is the
 * default, for a human opening the link directly.
 */

import type { Instance } from "../store/types.js";

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

const PAGE_STYLE = `
  body { background: #f2ead6; color: #11110f; font-family: -apple-system, system-ui, Segoe UI, sans-serif; margin: 0; padding: 2rem; }
  .signatures-gallery-page { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  .canonical img { width: 100%; max-width: 420px; display: block; margin: 1rem 0; }
  .instance { border-top: 1px solid #d8cdb0; padding: 0.75rem 0; display: flex; gap: 0.75rem; align-items: center; }
  .instance img { width: 84px; height: 84px; flex: none; }
  .instance .meta { font-size: 0.85rem; line-height: 1.4; }
  .instance .code { font-family: ui-monospace, monospace; }
  .provenance-verified { color: #2f6b3a; }
  .provenance-unverified { color: #8a7a55; }
  a { color: #11110f; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; font-size: 0.9rem; }
  dt { font-weight: 600; }
  dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-all; }
`;

export function renderClusterPage(handle: string, canonicalImageUrl: string, instances: Instance[]): string {
  const rows = instances
    .map(
      (instance) => `
    <div class="instance">
      <img src="/i/instance/${encodeURIComponent(instance.id)}.png" alt="Instance #${instance.sequence}" />
      <div class="meta">
        <div>#${instance.sequence} · <span class="code">${escapeHtml(instance.readingCode)}</span> ·
          <span class="provenance-${instance.provenance}">${instance.provenance}</span></div>
        ${instance.rationale ? `<div>${escapeHtml(instance.rationale)}</div>` : ""}
        <div><a href="/v/${encodeURIComponent(instance.id)}">verify</a></div>
      </div>
    </div>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>@${escapeHtml(handle)} — signatures.gallery</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="signatures-gallery-page">
<h1>@${escapeHtml(handle)}</h1>
<div class="canonical"><img src="${escapeHtml(canonicalImageUrl)}" alt="Canonical signature for @${escapeHtml(handle)}" /></div>
${instances.length === 0 ? "<p>No instances yet.</p>" : rows}
</div>
</body>
</html>`;
}

export function renderVerifyPage(instance: Instance, specHash: string): string {
  const fields: [string, string][] = [
    ["seed_handle", instance.seedHandle],
    ["reading_code", instance.readingCode],
    ["reading", JSON.stringify(instance.readingJson)],
    ["source_post_id", instance.sourcePostId],
    ["offset_vector", JSON.stringify(instance.offsetVector)],
    ["spec_version", instance.specVersion],
    ["map_version", instance.mapVersion],
    ["schema_version", instance.schemaVersion],
    ["spec_hash", specHash],
  ];

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Instance #${instance.sequence} — signatures.gallery</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="signatures-gallery-page">
<h1>@${escapeHtml(instance.seedHandle)} — instance #${instance.sequence}</h1>
<p>Everything needed to recompute this instance independently from public information plus this record.</p>
<dl>
${fields.map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join("\n")}
</dl>
<p><a href="/c/${encodeURIComponent(instance.seedHandle)}">back to cluster</a></p>
</div>
</body>
</html>`;
}
