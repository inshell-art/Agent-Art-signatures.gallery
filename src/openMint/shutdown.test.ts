import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { closeHttpServer } from "./shutdown.js";

async function listeningServer(): Promise<Server> {
  const server = createServer((_request, response) => response.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function preconnect(server: Server): Promise<Socket> {
  const accepted = once(server, "connection");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  const socket = connect(address.port, "127.0.0.1");
  await Promise.all([once(socket, "connect"), accepted]);
  return socket;
}

describe("bounded open-mint HTTP shutdown", () => {
  it.each([false, true])("closes an open browser socket after the deadline (incomplete request: %s)", async incomplete => {
    const server = await listeningServer();
    const socket = await preconnect(server);
    const closed = once(socket, "close");
    if (incomplete) socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
    const forceClose = vi.spyOn(server, "closeAllConnections");
    try {
      await closeHttpServer(server, 30);
      await closed;
      expect(server.listening).toBe(false);
      expect(forceClose).toHaveBeenCalledOnce();
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      server.closeAllConnections();
      if (server.listening) await closeHttpServer(server, 1);
    }
  });

  it("clears the forced-close timer after ordinary draining", async () => {
    const server = await listeningServer();
    const forceClose = vi.spyOn(server, "closeAllConnections");
    await closeHttpServer(server, 20);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(forceClose).not.toHaveBeenCalled();
  });

  it("treats an already-closed server as drained", async () => {
    await expect(closeHttpServer(createServer(), 1)).resolves.toBeUndefined();
  });

  it("propagates unexpected close errors", async () => {
    const server = createServer();
    vi.spyOn(server, "close").mockImplementation(callback => {
      callback?.(new Error("close failed"));
      return server;
    });
    await expect(closeHttpServer(server, 1)).rejects.toThrow("close failed");
  });
});
