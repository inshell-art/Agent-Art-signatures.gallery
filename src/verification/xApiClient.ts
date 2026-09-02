/**
 * Provenance verification — handoff §9.3: "verify via the X API that
 * `source_post_id` exists, was authored by `handle`, and mentions the
 * agent."
 *
 * Real client against X API v2 (app-only bearer auth) — untested against
 * the live API here, same caveat as claim/xOAuthClient.ts: it needs a
 * registered app's credentials to exercise for real.
 */

export interface XApiClient {
  /**
   * Resolves true only if the post exists, was authored by `handle`
   * (case-insensitive), and its entities mention `agentHandle`.
   */
  verifyMention(params: { postId: string; handle: string; agentHandle: string }): Promise<boolean>;
}

const TWEET_LOOKUP_URL = "https://api.x.com/2/tweets";

export interface XApiConfig {
  bearerToken: string;
}

export class RealXApiClient implements XApiClient {
  constructor(private config: XApiConfig) {}

  async verifyMention(params: { postId: string; handle: string; agentHandle: string }): Promise<boolean> {
    const url = new URL(`${TWEET_LOOKUP_URL}/${encodeURIComponent(params.postId)}`);
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "username");
    url.searchParams.set("tweet.fields", "entities");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.config.bearerToken}` } });
    if (!res.ok) return false;

    const body = (await res.json()) as {
      data?: { author_id?: string; entities?: { mentions?: { username: string }[] } };
      includes?: { users?: { id: string; username: string }[] };
    };
    if (!body.data) return false;

    const author = body.includes?.users?.find((user) => user.id === body.data?.author_id);
    if (!author || author.username.toLowerCase() !== params.handle.toLowerCase()) return false;

    const mentions = body.data.entities?.mentions ?? [];
    return mentions.some((mention) => mention.username.toLowerCase() === params.agentHandle.toLowerCase());
  }
}
