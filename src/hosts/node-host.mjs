/**
 * Node function host.
 *
 * Serves a single exported handler over HTTP. The developer writes what
 * happens on a request; the listening, the lifecycle and the timeout are
 * Quai's job.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const handlerPath = process.env.QUAI_HANDLER ?? "index.js";
const timeoutMs = Number(process.env.QUAI_TIMEOUT_MS ?? 30000);
const port = Number(process.env.PORT ?? 8080);

const loaded = await import(pathToFileURL(resolve(handlerPath)).href);
const handler = loaded.default ?? loaded.handler;

if (typeof handler !== "function") {
  console.error(
    "quai: " +
      handlerPath +
      " must export a handler function, " +
      "either as the default export or as 'handler'.",
  );
  process.exit(1);
}

createServer((request, response) => {
  // A stuck request must not hold a connection open forever; the caller gets a
  // definite answer instead of hanging.
  const timer = setTimeout(() => {
    if (!response.headersSent) {
      response.statusCode = 504;
      response.end("Function timed out after " + timeoutMs + "ms");
    }
  }, timeoutMs);

  response.on("finish", () => clearTimeout(timer));

  try {
    const result = handler(request, response);
    if (result instanceof Promise) {
      result.catch((error) => {
        clearTimeout(timer);
        console.error(error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end("Function failed");
        }
      });
    }
  } catch (error) {
    clearTimeout(timer);
    console.error(error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end("Function failed");
    }
  }
}).listen(port, "0.0.0.0", () => {
  console.log("quai function host listening on " + port);
});
