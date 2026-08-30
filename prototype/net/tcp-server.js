// A project that listens on a TCP port, the naive way.
const net = require("net");
const port = Number(process.argv[2]);
const srv = net.createServer((s) => {
  s.on("error", () => {});           // a scanner's RST must not kill us
  s.end("SECRET-OF-" + process.argv[3] + "\n");
});
srv.on("error", () => {});
srv.listen(port, "0.0.0.0", () => process.stdout.write("listening " + port + "\n"));
