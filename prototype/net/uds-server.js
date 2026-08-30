// The same project, listening on a Unix socket inside its own home instead.
const net = require("net");
const fs = require("fs");
const path = process.argv[2];
try { fs.unlinkSync(path); } catch {}
net.createServer((s) => s.end("SECRET-OF-" + process.argv[3] + "\n"))
   .listen(path, () => { fs.chmodSync(path, 0o660);
                         process.stdout.write("listening " + path + "\n"); });
