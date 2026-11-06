import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomaticCaptureQueue, type AutomaticQueueDependencies } from '../automaticCaptureQueue';
import type { Capture, CaptureDraft, LocalPhoto } from '../types';

const photo = (id = 'photo'): LocalPhoto => ({ id, sha256: id, size: 5, order: 0, name: `${id}.jpg`, blob: new Blob(['image'], { type: 'image/jpeg' }) });
const capture = (id: string, state: Capture['state'] = 'uploading'): Capture => ({ id, bin_id: 'drawer', state, sequence: 1,
  captured_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), received_at: null, cleanup_completed_at: null, photos: [] });
const draft = (extra: Partial<CaptureDraft> = {}): CaptureDraft => ({ id: 'saved', ownerId: 'owner', binId: 'drawer', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(), sealed: true, photos: [photo()], ...extra });
const file = () => new File(['image'], 'photo.jpg', { type: 'image/jpeg' });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const queues: AutomaticCaptureQueue[] = [];
afterEach(() => { for (const queue of queues) queue.dispose(); queues.length = 0; });
function setup(saved: CaptureDraft[] = []) {
  let id = 0;
  const deps = {
    client: {
      get: vi.fn(async (key: string) => capture(key)), create: vi.fn(async (next: CaptureDraft) => capture(next.id)),
      upload: vi.fn(async () => ({})), complete: vi.fn(async (key: string) => capture(key, 'queued')),
      cancel: vi.fn(async (key: string) => capture(key, 'cancelled')), list: vi.fn(async () => []),
    },
    storage: { load: vi.fn(async () => saved), save: vi.fn(async (_value: CaptureDraft) => true), clear: vi.fn(async (_key: string) => {}) },
    prepare: vi.fn(async () => photo(`photo-${++id}`)), id: vi.fn(() => `capture-${++id}`), changed: vi.fn(), pollMs: 60000,
  } satisfies AutomaticQueueDependencies;
  const queue = new AutomaticCaptureQueue('owner', { maxPhotos: 20, maxPhotoBytes: 5000000, uploadExpiryMs: 3600000, modelConfigured: true, supportedMimeTypes: ['image/jpeg'] }, deps);
  queues.push(queue);
  return { queue, deps };
}

describe('automatic photo queue', () => {
  it('persists, registers, uploads and completes one stable manifest automatically', async () => {
    const { queue, deps } = setup();
    deps.client.get.mockRejectedValue({ status: 404 });
    const accepted = deferred<Capture>();
    deps.client.complete.mockImplementation(() => accepted.promise);
    queue.enqueue([file()], { id: 'drawer', name: '抽屉' });
    await vi.waitFor(() => expect(deps.client.complete).toHaveBeenCalledOnce());
    const id = queue.getSnapshot()[0].id;
    expect(deps.storage.save.mock.invocationCallOrder[0]).toBeLessThan(deps.client.create.mock.invocationCallOrder[0]);
    expect(deps.client.create).toHaveBeenCalledWith(expect.objectContaining({ id, binId: 'drawer', automatic: true, sealed: true }));
    expect(deps.client.complete).toHaveBeenCalledWith(id, [expect.objectContaining({ order: 0, size: 5 })]);
    expect(deps.storage.clear).not.toHaveBeenCalled();
    expect(queue.getSnapshot()[0].accepted).toBe(false);
    accepted.resolve(capture(id, 'queued'));
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('recognizing'));
    expect(deps.storage.clear).toHaveBeenCalledWith(id);
  });

  it('takes the next photo while the first upload waits and fixes each photo to its original place', async () => {
    const { queue, deps } = setup();
    const first = deferred<unknown>();
    deps.client.upload.mockImplementationOnce(() => first.promise as Promise<object>);
    queue.enqueue([file()], { id: 'drawer', name: '抽屉' });
    await vi.waitFor(() => expect(deps.client.upload).toHaveBeenCalledOnce());
    queue.enqueue([file()], { id: 'shelf', name: '架子' });
    await vi.waitFor(() => expect(deps.client.complete).toHaveBeenCalledOnce());
    const tasks = queue.getSnapshot();
    expect(tasks.find((task) => task.binId === 'drawer')?.phase).toBe('uploading');
    expect(tasks.find((task) => task.binId === 'shelf')?.phase).toBe('recognizing');
    first.resolve({});
    await vi.waitFor(() => expect(deps.client.complete).toHaveBeenCalledTimes(2));
  });

  it('keeps every gallery photo independent', async () => {
    const { queue, deps } = setup();
    queue.enqueue([file(), file(), file()], { id: 'drawer', name: '抽屉' });
    await vi.waitFor(() => expect(deps.client.complete).toHaveBeenCalledTimes(3));
    expect(new Set(deps.client.complete.mock.calls.map(([id]) => id)).size).toBe(3);
    for (const call of deps.client.complete.mock.calls as unknown as [string, LocalPhoto[]][]) expect(call[1]).toHaveLength(1);
  });

  it('preserves files across a lost completion reply and reconciles before retrying uploads', async () => {
    const { queue, deps } = setup();
    deps.client.complete.mockRejectedValueOnce(new Error('响应丢失'));
    queue.enqueue([file()], { id: 'drawer', name: '抽屉' });
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('failed'));
    expect(deps.storage.clear).not.toHaveBeenCalled();
    const id = queue.getSnapshot()[0].id;
    deps.client.get.mockResolvedValue(capture(id, 'processing'));
    queue.retry(id);
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('recognizing'));
    expect(deps.client.upload).toHaveBeenCalledOnce();
    expect(deps.storage.clear).toHaveBeenCalledWith(id);
  });

  it('persists cancellation before contacting the server and stops a late upload from completing', async () => {
    const { queue, deps } = setup();
    const upload = deferred<unknown>();
    deps.client.upload.mockImplementation(() => upload.promise as Promise<object>);
    queue.enqueue([file()], { id: 'drawer', name: '抽屉' });
    await vi.waitFor(() => expect(deps.client.upload).toHaveBeenCalledOnce());
    const id = queue.getSnapshot()[0].id;
    await queue.cancel(id);
    expect(deps.storage.save).toHaveBeenLastCalledWith(expect.objectContaining({ cancelRequested: true }));
    expect(deps.storage.save.mock.invocationCallOrder[deps.storage.save.mock.invocationCallOrder.length - 1]).toBeLessThan(deps.client.cancel.mock.invocationCallOrder[0]);
    expect(deps.client.cancel).toHaveBeenCalledWith(id, 'drawer');
    upload.resolve({});
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('cancelled'));
    expect(deps.client.complete).not.toHaveBeenCalled();
  });

  it('never restarts an expired cancelled draft after an offline reload', async () => {
    const saved = draft({ cancelRequested: true, expiresAt: '2000-01-01T00:00:00Z' });
    const { queue, deps } = setup([saved]);
    deps.client.cancel.mockRejectedValueOnce(new Error('离线'));
    await queue.start();
    await vi.waitFor(() => expect(queue.getSnapshot()[0].error).toContain('取消尚未同步'));
    expect(deps.client.create).not.toHaveBeenCalled();
    expect(deps.client.upload).not.toHaveBeenCalled();
    expect(deps.storage.clear).not.toHaveBeenCalled();
    queue.retryDisconnected();
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('cancelled'));
  });

  it('cancels before compression completes without registering the photo', async () => {
    const { queue, deps } = setup();
    const preparing = deferred<LocalPhoto>();
    deps.prepare.mockImplementation(() => preparing.promise);
    queue.enqueue([file()], { id: 'drawer', name: '抽屉' });
    await queue.cancel(queue.getSnapshot()[0].id);
    preparing.resolve(photo());
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('cancelled'));
    expect(deps.client.create).not.toHaveBeenCalled();
    expect(deps.client.upload).not.toHaveBeenCalled();
    expect(deps.storage.save.mock.calls.every(([value]) => value.cancelRequested)).toBe(true);
  });

  it('restores an old multi-photo draft as its original whole manifest', async () => {
    const saved = draft({ photos: [photo('one'), { ...photo('two'), order: 1 }] });
    const { queue, deps } = setup([saved]);
    deps.client.get.mockResolvedValue({ ...capture('saved'), photos: [{ ...photo('one'), received_at: new Date().toISOString() }] });
    await queue.start();
    await vi.waitFor(() => expect(deps.client.complete).toHaveBeenCalledOnce());
    expect(deps.client.upload).toHaveBeenCalledOnce();
    expect(deps.client.create).not.toHaveBeenCalled();
    expect(deps.client.complete).toHaveBeenCalledWith('saved', [
      { id: 'one', sha256: 'one', size: 5, order: 0 }, { id: 'two', sha256: 'two', size: 5, order: 1 },
    ]);
  });

  it('keeps an offline photo beyond its local deadline and creates it after reconnecting', async () => {
    const saved = draft({ automatic: true, expiresAt: '2000-01-01T00:00:00Z' });
    const { queue, deps } = setup([saved]);
    deps.client.get.mockRejectedValue({ status: 404 });
    deps.client.create.mockRejectedValueOnce(new Error('离线'));
    await queue.start();
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('failed'));
    expect(queue.getSnapshot()[0].photos[0].blob).toBe(saved.photos[0].blob);
    expect(deps.storage.clear).not.toHaveBeenCalled();
    queue.retryDisconnected();
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('recognizing'));
    expect(deps.client.create).toHaveBeenCalledTimes(2);
    expect(deps.client.complete).toHaveBeenCalledOnce();
  });

  it('reuploads a confirmed expired capture under a new ID and only clears the old copy after ACK', async () => {
    const saved = draft();
    const { queue, deps } = setup([saved]);
    deps.client.get.mockImplementation(async (id) => {
      if (id === 'saved') return capture(id, 'expired');
      throw { status: 404 };
    });
    const accepted = deferred<Capture>();
    deps.client.complete.mockImplementation(() => accepted.promise);
    await queue.start();
    await vi.waitFor(() => expect(queue.getSnapshot()[0].expired).toBe(true));
    expect(deps.storage.clear).not.toHaveBeenCalled();
    queue.retry('saved');
    await vi.waitFor(() => expect(deps.client.complete).toHaveBeenCalledOnce());
    const id = queue.getSnapshot()[0].id;
    expect(id).not.toBe('saved');
    expect(deps.client.create).toHaveBeenCalledWith(expect.objectContaining({ replacesId: 'saved', photos: saved.photos }));
    expect(deps.storage.clear).not.toHaveBeenCalled();
    accepted.resolve(capture(id, 'queued'));
    await vi.waitFor(() => expect(deps.storage.clear.mock.calls).toEqual([['saved'], [id]]));
  });

  it('a late create rejected by the cancellation tombstone never becomes a retryable upload', async () => {
    const { queue, deps } = setup();
    deps.client.get.mockRejectedValue({ status: 404 });
    const registering = deferred<Capture>();
    deps.client.create.mockImplementation(() => registering.promise);
    queue.enqueue([file()], { id: 'drawer', name: '抽屉' });
    await vi.waitFor(() => expect(deps.client.create).toHaveBeenCalledOnce());
    const id = queue.getSnapshot()[0].id;
    await queue.cancel(id);
    registering.reject(Object.assign(new Error('已取消'), { status: 410, code: 'CAPTURE_CANCELLED' }));
    await vi.waitFor(() => expect(queue.getSnapshot()[0].phase).toBe('cancelled'));
    expect(deps.client.upload).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'complete'])('does not resurrect predecessors after two replacements and %s', async (finish) => {
    const original = draft({ id: 'A' });
    const { queue, deps } = setup([original]);
    const records = new Map<string, CaptureDraft>([['A', original]]);
    deps.storage.save.mockImplementation(async (entry) => { records.set(entry.id, entry); return true; });
    deps.storage.clear.mockImplementation(async (id) => { records.delete(id); });
    deps.client.get.mockImplementation(async (id) => capture(id, 'expired'));
    await queue.start();
    await vi.waitFor(() => expect(queue.getSnapshot()[0].expired).toBe(true));
    queue.retry('A');
    await vi.waitFor(() => expect(queue.getSnapshot()[0].expired).toBe(true));
    const middleId = queue.getSnapshot()[0].id;
    const waiting = deferred<Capture>();
    deps.client.get.mockImplementation(() => waiting.promise);
    queue.retry(middleId);
    const newestId = queue.getSnapshot()[0].id;
    await vi.waitFor(() => expect(records.has(newestId)).toBe(true));
    expect(records.get(newestId)?.replacesIds).toEqual(['A', middleId]);
    if (finish === 'cancel') await queue.cancel(newestId);
    else waiting.resolve(capture(newestId, 'queued'));
    await vi.waitFor(() => expect(records.size).toBe(0));
    const restored = setup([...records.values()]);
    await restored.queue.start();
    expect(restored.queue.getSnapshot()).toEqual([]);
    expect(restored.deps.client.upload).not.toHaveBeenCalled();
    waiting.resolve(capture(newestId, 'uploading'));
  });

  it('restores only the latest replacement and recovers its blob from an older copy', async () => {
    const original = draft({ id: 'A' });
    const middle = draft({ id: 'B', replacesId: 'A' });
    const newest = draft({ id: 'C', replacesId: 'B', photos: [{ ...photo(), blob: undefined }] });
    const { queue, deps } = setup([original, middle, newest]);
    await queue.start();
    await vi.waitFor(() => expect(deps.client.upload).toHaveBeenCalledOnce());
    expect(queue.getSnapshot().map((entry) => entry.id)).toEqual(['C']);
    expect(deps.client.upload).toHaveBeenCalledWith('C', expect.objectContaining({ blob: original.photos[0].blob }));
    await vi.waitFor(() => expect(deps.storage.clear.mock.calls).toEqual([['A'], ['B'], ['C']]));
  });
});
