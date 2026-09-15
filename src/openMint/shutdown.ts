import type { Server } from "node:http";

/** Stop accepting requests, then bound HTTP draining before durable application shutdown. */
export async function closeHttpServer(server: Server, graceMs = 5_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Browsers can retain preconnected or incomplete HTTP sockets indefinitely.
    // Start the deadline before close(), which first stops the listener.
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    timer.unref();
    server.close(error => {
      clearTimeout(timer);
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}
