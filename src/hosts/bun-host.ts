/**
 * Bun function host.
 *
 * Same contract as the Node host, expressed with Bun's fetch-style handler:
 * the developer exports a function taking a Request and returning a Response.
 */

import { resolve } from "node:path";

const handlerPath = process.env.QUAI_HANDLER ?? "index.ts";
const timeoutMs = Number(process.env.QUAI_TIMEOUT_MS ?? 30000);
const port = Number(process.env.PORT ?? 8080);

const loaded = await import(resolve(handlerPath));
const handler = loaded.default ?? loaded.handler ?? loaded.fetch;

if (typeof handler !== "function") {
  console.error(
    `quai: ${handlerPath} must export a handler function, either as the ` +
      "default export or as 'handler'.",
  );
  process.exit(1);
}

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    // A stuck request gets a definite answer rather than holding the
    // connection open indefinitely.
    const timeout = new Promise<Response>((resolveTimeout) =>
      setTimeout(
        () =>
          resolveTimeout(new Response(`Function timed out after ${timeoutMs}ms`, { status: 504 })),
        timeoutMs,
      ),
    );

    try {
      return await Promise.race([Promise.resolve(handler(request)), timeout]);
    } catch (error) {
      console.error(error);
      return new Response("Function failed", { status: 500 });
    }
  },
});

console.log(`quai function host listening on ${port}`);
