import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCaptureId, photoSha256 } from '../captureCrypto';

const vectors = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['The quick brown fox jumps over the lazy dog', 'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
];

afterEach(() => vi.unstubAllGlobals());

describe('capture cryptography on LAN HTTP', () => {
  it.each(vectors)('hashes the standard vector %j without SubtleCrypto', async (input, expected) => {
    vi.stubGlobal('crypto', { getRandomValues: vi.fn() });
    expect(await photoSha256(new TextEncoder().encode(input).buffer)).toBe(expected);
  });

  it('builds UUID v4 IDs using getRandomValues when randomUUID is unavailable', () => {
    let sequence = 0;
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(++sequence);
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const first = createCaptureId();
    const second = createCaptureId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });

  it('keeps the native digest implementation when WebCrypto is available', async () => {
    const digest = vi.fn().mockResolvedValue(new Uint8Array([0x12, 0xab]).buffer);
    vi.stubGlobal('crypto', { subtle: { digest } });
    const data = new TextEncoder().encode('abc').buffer;
    expect(await photoSha256(data)).toBe('12ab');
    expect(digest).toHaveBeenCalledWith('SHA-256', data);
  });

  it('does not hide failures from an available WebCrypto implementation', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(new Error('digest unavailable')) } });
    await expect(photoSha256(new ArrayBuffer(0))).rejects.toThrow('digest unavailable');
  });

  it('keeps native UUID generation when available', () => {
    const randomUUID = vi.fn().mockReturnValue('native-uuid');
    vi.stubGlobal('crypto', { randomUUID });
    expect(createCaptureId()).toBe('native-uuid');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}])('gives a clear error when no secure RNG is available', (cryptoApi) => {
    vi.stubGlobal('crypto', cryptoApi);
    expect(() => createCaptureId()).toThrow('此浏览器不支持安全随机数');
  });
});
