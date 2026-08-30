// Deliberate memory hog: allocates until the cgroup cap kills it.
// If the cap works, this process never reaches the "escaped" line.
const chunks = [];
const CHUNK = 8 * 1024 * 1024; // 8 MiB
for (let i = 0; i < 64; i++) {
  const buf = Buffer.alloc(CHUNK, 0x71);
  buf[0] = i; // touch it so the pages are really faulted in
  chunks.push(buf);
}
console.log("escaped: allocated", (chunks.length * CHUNK) / 1048576, "MiB");
process.exit(0);
