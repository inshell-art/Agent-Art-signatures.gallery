/** Static operator configuration only. Never append request codes or diagnostic data. */
export function openMintSupportUrl(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  const invalid = () => new Error("OPEN_MINT_SUPPORT_URL must be an HTTPS URL without credentials.");
  if (typeof value !== "string" || value.length > 2048 || /[\\\u0000-\u0020]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.username || url.password) throw invalid();
  return url.href;
}
