// Reads the files in a .zip archive, such as a backup exported by another userscript manager. Supports the stored and
// deflate methods every zip tool writes, using the browser's DecompressionStream, so no library is needed.

const limits = { files: 5000, bytes: 100 * 1024 * 1024 };

/** @param {Uint8Array} bytes */
export function isZip(bytes) {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Returns each file's path and contents. Folders are left out.
 * @param {Uint8Array} bytes
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The central directory's end record sits in the last 22 bytes plus an optional comment of up to 64 KB.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("This file isn’t a complete zip archive.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > limits.files) throw new Error(`This archive has more than ${limits.files} files.`);
  const decoder = new TextDecoder();
  const files = new Map();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("This zip archive is damaged.");
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeader = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (compressedSize === 0xffffffff || size === 0xffffffff) throw new Error("Zip archives over 4 GB aren’t supported.");
    total += size;
    if (total > limits.bytes) throw new Error("This archive is larger than 100 MB once unpacked.");
    const start = localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true);
    const data = bytes.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, data);
    else if (method === 8) {
      const inflated = await inflate(data);
      if (inflated.length !== size) throw new Error(`${name} in this archive is damaged.`);
      files.set(name, inflated);
    } else throw new Error(`${name} uses a zip compression method Tailorscript can’t read.`);
  }
  return files;
}
