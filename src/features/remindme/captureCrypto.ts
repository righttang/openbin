import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { v4 as uuidv4 } from 'uuid';

/** getRandomValues remains available on LAN HTTP, unlike randomUUID and SubtleCrypto. */
export function createCaptureId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('此浏览器不支持安全随机数，无法开始拍摄。请更新 Safari 或 Chrome 后重试。');
  }
  return uuidv4({ random: cryptoApi.getRandomValues(new Uint8Array(16)) });
}

/** Preserve the same SHA-256 upload checksum on HTTPS, localhost, and LAN HTTP. */
export async function photoSha256(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest === 'function') {
    return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', data)));
  }
  return bytesToHex(sha256(new Uint8Array(data)));
}
