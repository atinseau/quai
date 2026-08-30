/**
 * Quai supervisor, PID 1.
 *
 * Refuses to start when the host cannot enforce project isolation: booting
 * anyway would let projects believe they are contained when they are not.
 */

import { checkIsolationSupport, formatFailures } from "./preflight";
import { parseProbe } from "./probe";
import { readRuntimes, readSystem } from "./system";
import { buildHealthReport } from "./health";

const HOMES_PATH = process.env.QUAI_HOMES ?? "/srv/quai/homes";
const PORT = Number(process.env.QUAI_PORT ?? 8080);
const SKIP_PREFLIGHT = process.env.QUAI_SKIP_PREFLIGHT === "1";

const isolation = checkIsolationSupport(parseProbe(await readSystem(HOMES_PATH)));
const runtimes = await readRuntimes();

if (!isolation.supported && !SKIP_PREFLIGHT) {
  console.error(formatFailures(isolation.failures));
  process.exit(1);
}

Bun.serve({
  port: PORT,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      const report = buildHealthReport({ isolation, runtimes });
      return Response.json(report, { status: report.status === "unhealthy" ? 503 : 200 });
    }
    return new Response("Not found", { status: 404 });
  },
});

const versions = runtimes.map((r) => `${r.name} ${r.version ?? "absent"}`).join(", ");
console.log(`quai supervisor listening on :${PORT} — runtimes: ${versions}`);

