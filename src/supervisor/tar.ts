/**
 * Minimal tar reading and writing.
 *
 * Quai ships its own rather than depending on the system tar, so the deploy
 * format is identical on every client platform and the supervisor never shells
 * out on untrusted input.
 */

const BLOCK = 512;

export type TarEntry = { name: string; contents: Uint8Array };

function writeString(block: Uint8Array, offset: number, value: string, length: number): void {
  const bytes = new TextEncoder().encode(value);
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, value: number, length: number): void {
  writeString(block, offset, value.toString(8).padStart(length - 1, "0"), length);
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  return text.length === 0 ? 0 : parseInt(text, 8);
}

/** Packs entries into a tar archive. */
export function packTar(entries: TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    const header = new Uint8Array(BLOCK);
    writeString(header, 0, entry.name, 100);
    writeOctal(header, 100, 0o644, 8); // mode
    writeOctal(header, 108, 0, 8); // uid
    writeOctal(header, 116, 0, 8); // gid
    writeOctal(header, 124, entry.contents.length, 12);
    writeOctal(header, 136, Math.floor(Date.now() / 1000), 12);
    header.fill(0x20, 148, 156); // checksum placeholder is spaces
    header[156] = 0x30; // type flag '0' = regular file
    writeString(header, 257, "ustar", 6);
    writeString(header, 263, "00", 2);

    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeOctal(header, 148, checksum, 8);
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header);

    const padded = new Uint8Array(Math.ceil(entry.contents.length / BLOCK) * BLOCK);
    padded.set(entry.contents);
    if (padded.length > 0) blocks.push(padded);
  }

  // Two zero blocks mark the end of the archive.
  blocks.push(new Uint8Array(BLOCK * 2));

  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive;
}

/** Unpacks a tar archive, ignoring anything that is not a regular file. */
export function unpackTar(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    offset += BLOCK;

    if (typeFlag === "0" || typeFlag === "\0") {
      entries.push({ name, contents: archive.slice(offset, offset + size) });
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}
