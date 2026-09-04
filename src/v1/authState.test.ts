import { describe, expect, it } from "vitest";
import { MemoryAuthState } from "./authState.js";

describe("MemoryAuthState", () => {
  it("binds one-time OAuth state to the originating session", () => {
    const auth = new MemoryAuthState();
    const a = auth.getOrCreateSession(null).session;
    const b = auth.getOrCreateSession(null).session;
    const { state } = auth.startFlow(a, "account_login", null, "verifier");
    expect(auth.beginCallback(b, state)).toBeNull();
    expect(auth.beginCallback(a, state)).toBeNull();
  });

  it("rejects callback replay and rotates the session on authentication", () => {
    const auth = new MemoryAuthState();
    const session = auth.getOrCreateSession(null).session;
    const { state } = auth.startFlow(session, "account_login", null, "verifier");
    const flow = auth.beginCallback(session, state)!;
    expect(flow.status).toBe("processing");
    expect(auth.beginCallback(session, state)).toBeNull();
    const rotated = auth.authenticate(flow, { xUserId: "1", username: "alice", handleNormalized: "alice", authenticatedAt: new Date() }, session);
    expect(rotated.id).not.toBe(session.id);
    expect(auth.getSession(session.id)).toBeNull();
  });
});
