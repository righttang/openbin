import { describe, expect, it, vi } from 'vitest';
import { type CaptureClient, finishCapture, hasAcceptedBatch } from '../captureClient';
import type { Capture, CaptureDraft } from '../types';

const photo = { id: 'photo-one', sha256: 'hash-one', size: 12, order: 0, name: 'drawer.jpg', blob: new Blob(['drawer image'], { type: 'image/jpeg' }) };
const draft: CaptureDraft = { id: 'capture-one', ownerId: 'owner', binId: 'drawer', createdAt: '2026-11-06T01:00:00Z', expiresAt: '2026-11-06T02:00:00Z', sealed: true, photos: [photo] };
const capture: Capture = { id: draft.id, bin_id: draft.binId, sequence: 3, state: 'uploading', captured_at: draft.createdAt, received_at: null, expires_at: draft.expiresAt, cleanup_completed_at: null, photos: [] };

function fixture(current: Capture = capture) {
  const client: CaptureClient = {
    get: vi.fn().mockResolvedValue(current),
    upload: vi.fn().mockResolvedValue({}),
    complete: vi.fn().mockResolvedValue({ ...current, state: 'queued' }),
  };
  return { client, clear: vi.fn().mockResolvedValue(undefined), progress: vi.fn() };
}

describe('durable capture upload boundary', () => {
  it('does not discard local photos when an upload is interrupted', async () => {
    const { client, clear, progress } = fixture();
    vi.mocked(client.upload).mockRejectedValue(new TypeError('network interrupted'));
    await expect(finishCapture(draft, client, clear, progress)).rejects.toThrow('network interrupted');
    expect(client.complete).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('does not report success or discard photos when the final acknowledgement is lost', async () => {
    const { client, clear, progress } = fixture();
    vi.mocked(client.complete).mockRejectedValue(new TypeError('connection lost'));
    await expect(finishCapture(draft, client, clear, progress)).rejects.toThrow('connection lost');
    expect(progress).toHaveBeenLastCalledWith(1, 1);
    expect(clear).not.toHaveBeenCalled();
  });

  it('recovers a lost completion response using the original capture without uploading twice', async () => {
    const { client, clear, progress } = fixture({ ...capture, state: 'processing' });
    const result = await finishCapture(draft, client, clear, progress);
    expect(client.get).toHaveBeenCalledWith(draft.id);
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
    expect(hasAcceptedBatch(result)).toBe(true);
  });

  it('resumes acknowledged files even if browser-local copies are missing', async () => {
    const { client, clear, progress } = fixture({ ...capture, photos: [{ ...photo, received_at: '2026-11-06T01:01:00Z' }] });
    const recovered = { ...draft, photos: [{ ...photo, blob: undefined }] };
    await finishCapture(recovered, client, clear, progress);
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.complete).toHaveBeenCalledWith(draft.id, [{ id: photo.id, sha256: photo.sha256, size: photo.size, order: photo.order }]);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('keeps a batch pending if completion has not accepted the full manifest', async () => {
    const { client, clear, progress } = fixture();
    vi.mocked(client.complete).mockResolvedValue(capture);
    await expect(finishCapture(draft, client, clear, progress)).rejects.toThrow('服务器尚未接收完整批次');
    expect(clear).not.toHaveBeenCalled();
    expect(hasAcceptedBatch(capture)).toBe(false);
  });

  it('rejects conflicting server hashes before completing or deleting anything', async () => {
    const { client, clear, progress } = fixture({ ...capture, photos: [{ ...photo, sha256: 'different', received_at: '2026-11-06T01:01:00Z' }] });
    await expect(finishCapture(draft, client, clear, progress)).rejects.toThrow('照片校验信息冲突');
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('never registers an expired interrupted capture as a newer capture', async () => {
    const { client, clear, progress } = fixture({ ...capture, state: 'expired' });
    await expect(finishCapture(draft, client, clear, progress)).rejects.toThrow('这批拍摄已过期');
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('clears local photos only after the server has accepted the complete batch', async () => {
    const { client, clear, progress } = fixture();
    const result = await finishCapture(draft, client, clear, progress);
    expect(result.state).toBe('queued');
    expect(vi.mocked(client.complete).mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]);
  });
});
