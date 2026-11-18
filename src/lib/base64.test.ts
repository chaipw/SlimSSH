import { describe, expect, it } from "vitest";
import { decodeBase64 } from "./base64";

function encodeLargeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const chunk = bytes.subarray(offset, offset + 4096);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

describe("decodeBase64", () => {
  it("安全解码完整的 64KiB 二进制输出", () => {
    const source = Uint8Array.from({ length: 64 * 1024 }, (_, index) => (index * 31 + 7) % 256);
    const decoded = decodeBase64(encodeLargeBytes(source));
    expect(decoded).toEqual(source);
  });

  it("跨内部解码块时保持字节位置", () => {
    const source = Uint8Array.from({ length: 16 * 1024 + 17 }, (_, index) => index % 256);
    expect(decodeBase64(encodeLargeBytes(source))).toEqual(source);
  });

  it("拒绝无效的 Base64 输入", () => {
    expect(() => decodeBase64("%%%")).toThrow();
  });
});
