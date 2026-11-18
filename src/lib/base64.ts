const DECODE_CHUNK_SIZE = 16 * 1024;

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let offset = 0; offset < binary.length; offset += DECODE_CHUNK_SIZE) {
    const end = Math.min(offset + DECODE_CHUNK_SIZE, binary.length);
    for (let index = offset; index < end; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  }

  return bytes;
}
