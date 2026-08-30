// A project port-scanning its neighbours over loopback.
const net = require("net");
const found = [];
let pending = 0;
for (let port = 3000; port <= 3010; port++) {
  pending++;
  const sock = net.connect({ host: "127.0.0.1", port });
  sock.setTimeout(700);
  const done = (hit) => { if (hit) found.push(port); sock.destroy();
                          if (--pending === 0) report(); };
  sock.on("connect", () => done(true));
  sock.on("error", () => done(false));
  sock.on("timeout", () => done(false));
}
function report() {
  process.stdout.write(found.length ? "OPEN PORTS: " + found.join(",") + "\n"
                                    : "OPEN PORTS: none\n");
}
