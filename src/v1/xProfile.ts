/** Link the displayed handle, without changing its recorded spelling or case. */
export function xProfileLink(handle: string): string {
  const username = handle.startsWith("@") ? handle.slice(1) : handle;
  // A malformed value remains text, never a URL or executable markup.
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    return `@${username.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;")}`;
  }
  return `<a class="x-profile" href="https://x.com/${username}" target="_blank" rel="noopener noreferrer" aria-label="@${username} on X (opens in a new tab)">@${username}</a>`;
}
