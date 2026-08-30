// Try to reach a neighbour. Prints REACHED + payload, or the errno.
const net = require("net");
const target = process.argv[2];
const opts = target.startsWith("/") ? { path: target }
                                    : { host: "127.0.0.1", port: Number(target) };
const sock = net.connect(opts);
sock.setTimeout(2000);
let buf = "";
sock.on("data", (d) => (buf += d));
sock.on("end", () => { process.stdout.write("REACHED " + buf.trim() + "\n"); process.exit(0); });
sock.on("timeout", () => { process.stdout.write("TIMEOUT\n"); process.exit(1); });
sock.on("error", (e) => { process.stdout.write("BLOCKED " + e.code + "\n"); process.exit(1); });
