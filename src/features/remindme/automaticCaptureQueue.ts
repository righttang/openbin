import { type AutomaticCaptureClient, hasAcceptedBatch } from './captureClient';
import type { Capture, CaptureConfig, CaptureDraft, LocalPhoto } from './types';

export type PhotoPhase = 'preparing' | 'waiting' | 'uploading' | 'recognizing' | 'done' | 'failed' | 'cancelling' | 'cancelled';
export interface PhotoTask {
  id: string;
  binId: string;
  binName: string;
  createdAt: string;
  phase: PhotoPhase;
  photos: LocalPhoto[];
  accepted: boolean;
  durable: boolean;
  error: string;
  received: number;
  cancelRequested: boolean;
  expired: boolean;
}
interface Task extends PhotoTask {
  draft: CaptureDraft;
  source?: File;
  writing: Promise<unknown>;
  running: boolean;
  cancelling: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
export interface AutomaticQueueDependencies {
  client: AutomaticCaptureClient;
  storage: { load(ownerId: string): Promise<CaptureDraft[]>; save(draft: CaptureDraft): Promise<boolean>; clear(id: string): Promise<void> };
  prepare(file: File, maxBytes: number, order: number): Promise<LocalPhoto>;
  id(): string;
  changed(): void;
  pollMs?: number;
}
const isPending = (capture: Capture) => ['queued', 'processing'].includes(capture.state);
const message = (error: unknown) => error instanceof Error ? error.message : '网络连接中断，请重试。';
const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
const predecessors = (draft: CaptureDraft) => [...new Set([...(draft.replacesIds ?? []), ...(draft.replacesId ? [draft.replacesId] : [])])].filter((id) => id !== draft.id);

/** Each selected photo owns its location, durable manifest and independent server job. */
export class AutomaticCaptureQueue {
  private tasks = new Map<string, Task>();
  private listeners = new Set<() => void>();
  private snapshot: PhotoTask[] = [];
  private started = false;
  private disposed = false;
  private active = 0;

  constructor(private ownerId: string, private config: CaptureConfig, private deps: AutomaticQueueDependencies) {}

  updateConfig(config: CaptureConfig) { this.config = config; }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ draft: _draft, source: _source, writing: _writing, running: _running, cancelling: _cancelling, timer: _timer, ...view }) => ({ ...view, photos: [...view.photos] }));
    for (const listener of this.listeners) listener();
  }

  private add(draft: CaptureDraft, source?: File): Task {
    const task: Task = {
      id: draft.id, binId: draft.binId, binName: draft.binName || '', createdAt: draft.createdAt,
      phase: draft.cancelRequested ? 'cancelling' : source ? 'preparing' : 'waiting',
      photos: draft.photos, accepted: false, durable: !source, error: '', received: 0,
      cancelRequested: !!draft.cancelRequested, expired: false, draft, source, writing: Promise.resolve(), running: false, cancelling: false,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      const saved = await this.deps.storage.load(this.ownerId);
      if (this.disposed) return;
      const byId = new Map(saved.map((draft) => [draft.id, draft]));
      const expand = (draft: CaptureDraft, seen = new Set<string>([draft.id])): string[] => {
        const result: string[] = [];
        for (const id of predecessors(draft)) {
          if (seen.has(id)) continue;
          seen.add(id);
          const previous = byId.get(id);
          if (previous) result.push(...expand(previous, seen));
          result.push(id);
        }
        return result;
      };
      const drafts = saved.map((draft) => ({ ...draft, replacesIds: expand(draft) }));
      const replaced = new Set(drafts.flatMap(predecessors));
      for (const draft of drafts) {
        if (this.tasks.has(draft.id) || replaced.has(draft.id)) continue;
        const originals = drafts.filter((entry) => predecessors(draft).includes(entry.id));
        const photos = draft.photos.map((photo) => ({ ...photo, blob: photo.blob ?? originals.flatMap((entry) => entry.photos).find((entry) => entry.sha256 === photo.sha256 && entry.blob)?.blob }));
        this.add({ ...draft, photos });
      }
      this.emit(); this.pump();
    } catch { /* New photos can still proceed if browser storage is unavailable. */ }
    try {
      const captures = await this.deps.client.list();
      if (this.disposed) return;
      for (const capture of captures.filter((entry) => hasAcceptedBatch(entry)).slice(0, 6)) {
        if (this.tasks.has(capture.id)) continue;
        const task = this.add({ id: capture.id, ownerId: this.ownerId, binId: capture.bin_id, createdAt: capture.captured_at,
          expiresAt: capture.expires_at, sealed: true, photos: capture.photos.map((photo) => ({ ...photo, name: '照片' })) });
        this.applyServer(task, capture);
      }
      this.emit();
    } catch { /* Existing local work recovers independently of the recent list. */ }
  }

  enqueue(files: File[], place: { id: string; name: string }) {
    const pending = [...this.tasks.values()].filter((task) => !task.accepted && task.phase !== 'cancelled').length;
    if (pending + files.length > 40) throw new Error('待上传照片较多，请等部分上传完成后继续拍照。');
    // Keep the scan screen small; full results remain on the history page.
    const finished = [...this.tasks.values()].filter((task) => ['done', 'cancelled'].includes(task.phase));
    for (const task of finished.slice(0, Math.max(0, finished.length - 5))) this.tasks.delete(task.id);
    for (const file of files) {
      const createdAt = new Date().toISOString();
      this.add({ id: this.deps.id(), ownerId: this.ownerId, binId: place.id, binName: place.name,
        createdAt, expiresAt: new Date(Date.now() + this.config.uploadExpiryMs).toISOString(),
        sealed: true, automatic: true, photos: [] }, file);
    }
    this.emit(); this.pump();
  }

  /** All writes for one task are ordered, so an older save cannot erase a cancellation. */
  private persist(task: Task): Promise<boolean> {
    const next = task.writing.catch(() => {}).then(() => this.deps.storage.save(task.draft));
    task.writing = next;
    return next;
  }

  private clear(task: Task): Promise<void> {
    const next = task.writing.catch(() => {}).then(async () => {
      // The old expired draft remains a recovery copy until its replacement is acknowledged.
      for (const id of predecessors(task.draft)) await this.deps.storage.clear(id);
      await this.deps.storage.clear(task.id);
    });
    task.writing = next;
    return next;
  }

  private pump() {
    if (this.disposed) return;
    // Cancellation recovery must not wait behind two interrupted uploads.
    for (const task of this.tasks.values()) {
      if (task.cancelRequested && task.phase === 'cancelling' && !task.cancelling && !task.error) void this.cancel(task.id);
    }
    for (const task of this.tasks.values()) {
      if (task.cancelRequested) continue;
      if (this.active >= 2) break;
      if (task.running || !['preparing', 'waiting'].includes(task.phase)) continue;
      task.running = true; this.active++;
      void this.run(task).finally(() => { task.running = false; this.active--; this.pump(); });
    }
  }

  private async run(task: Task) {
    try {
      if (task.source && !task.photos.length) {
        task.phase = 'preparing'; this.emit();
        const photo = await this.deps.prepare(task.source, this.config.maxPhotoBytes, 0);
        if (task.cancelRequested) return;
        task.photos = [photo]; task.draft = { ...task.draft, photos: task.photos };
      }
      if (task.cancelRequested) return;
      task.durable = await this.persist(task);
      if (task.cancelRequested) return;
      task.phase = 'uploading'; task.error = ''; this.emit();
      let current: Capture;
      try { current = await this.deps.client.get(task.id); }
      catch (error) {
        if (task.cancelRequested) return;
        if (!isNotFound(error) || !task.draft.automatic) throw error;
        current = await this.deps.client.create(task.draft);
      }
      if (task.cancelRequested) return;
      if (current.state === 'cancelled') { await this.acknowledgeCancellation(task); return; }
      if (!hasAcceptedBatch(current)) {
        if (current.state !== 'uploading') {
          task.expired = current.state === 'expired';
          throw new Error('上传已过期，原照片仍保留。点击“重新上传”即可继续。');
        }
        if (!task.photos.length) throw new Error('这次拍摄没有照片，请取消后重新拍照。');
        const received = new Map(current.photos.map((photo) => [photo.id, photo]));
        task.received = 0;
        for (const photo of task.photos) {
          if (task.cancelRequested) return;
          const existing = received.get(photo.id);
          if (existing && existing.sha256 !== photo.sha256) throw new Error('照片校验不一致，请取消后重新拍照。');
          if (!existing?.received_at) await this.deps.client.upload(task.id, photo);
          task.received++; this.emit();
        }
        if (task.cancelRequested) return;
        current = await this.deps.client.complete(task.id, task.photos.map(({ id, sha256, size, order }) => ({ id, sha256, size, order })));
        if (task.cancelRequested) return;
        if (!hasAcceptedBatch(current)) throw new Error('尚未确认上传完成，请重试。');
      }
      // The server acknowledged the complete manifest. Only now may the local blob be removed.
      await this.clear(task);
      if (task.cancelRequested) return;
      task.source = undefined;
      this.applyServer(task, current);
    } catch (error) {
      if (task.cancelRequested) return;
      // A cancellation tombstone also wins a create request that arrived late.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'CAPTURE_CANCELLED') {
        await this.acknowledgeCancellation(task); return;
      }
      task.phase = 'failed'; task.error = message(error);
    } finally { this.emit(); }
  }

  private applyServer(task: Task, capture: Capture) {
    if (task.cancelRequested) return;
    task.accepted = hasAcceptedBatch(capture);
    task.durable = true;
    task.phase = isPending(capture) ? 'recognizing' : capture.state === 'failed' ? 'failed' : 'done';
    task.error = capture.state === 'failed' ? '识别失败，已有物品仍保留。可以重新拍照。' : '';
    if (isPending(capture)) this.schedulePoll(task);
    else this.deps.changed();
  }

  private schedulePoll(task: Task) {
    clearTimeout(task.timer);
    if (this.disposed || task.cancelRequested) return;
    task.timer = setTimeout(async () => {
      try {
        const capture = await this.deps.client.get(task.id);
        if (task.cancelRequested || this.disposed) return;
        if (capture.state === 'cancelled') await this.acknowledgeCancellation(task);
        else this.applyServer(task, capture);
        this.emit();
      } catch { if (!task.cancelRequested) this.schedulePoll(task); }
    }, this.deps.pollMs ?? 2500);
  }

  async cancel(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.phase === 'cancelled' || task.cancelling) return;
    task.cancelRequested = true; task.cancelling = true; task.phase = 'cancelling'; task.error = '';
    task.draft = { ...task.draft, cancelRequested: true };
    clearTimeout(task.timer); this.emit();
    try {
      task.durable = await this.persist(task);
      this.emit();
      await this.deps.client.cancel(task.id, task.binId);
      await this.acknowledgeCancellation(task);
    } catch (error) {
      task.error = `取消尚未同步：${message(error)}`;
    } finally { task.cancelling = false; this.emit(); }
  }

  private async acknowledgeCancellation(task: Task) {
    task.cancelRequested = true;
    task.draft = { ...task.draft, cancelRequested: true };
    await this.clear(task);
    task.phase = 'cancelled'; task.error = ''; task.photos = []; task.source = undefined;
    task.accepted = true; task.durable = true;
    clearTimeout(task.timer);
    this.deps.changed();
  }

  retry(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.running) return;
    if (task.cancelRequested) { void this.cancel(id); return; }
    if (task.accepted) return;
    if (task.expired) {
      // Only a confirmed expired server state permits registering the same files again.
      const next = this.add({ ...task.draft, id: this.deps.id(), automatic: true, replacesId: task.id, replacesIds: [...predecessors(task.draft), task.id],
        expiresAt: new Date(Date.now() + this.config.uploadExpiryMs).toISOString() });
      next.durable = false;
      this.tasks.delete(task.id);
      this.emit(); this.pump(); return;
    }
    task.phase = task.source && !task.photos.length ? 'preparing' : 'waiting'; task.error = '';
    this.emit(); this.pump();
  }

  async replaceMissing(id: string, files: File[]) {
    const task = this.tasks.get(id);
    if (!task || task.cancelRequested || task.running) return;
    try {
      for (const file of files) {
        const prepared = await this.deps.prepare(file, this.config.maxPhotoBytes, 0);
        if (task.cancelRequested) return;
        const index = task.photos.findIndex((photo) => !photo.blob && photo.sha256 === prepared.sha256);
        if (index === -1) throw new Error('请选择原来的照片，其他照片请用“拍照”或“选照片”添加。');
        task.photos = task.photos.map((photo, i) => i === index ? { ...photo, blob: prepared.blob } : photo);
      }
      task.draft = { ...task.draft, photos: task.photos };
      task.durable = await this.persist(task);
      this.retry(id);
    } catch (error) { task.error = message(error); this.emit(); }
  }

  retryDisconnected = () => {
    for (const task of this.tasks.values()) if (task.phase === 'failed' || (task.cancelRequested && task.error)) this.retry(task.id);
  };

  dispose() {
    this.disposed = true;
    for (const task of this.tasks.values()) clearTimeout(task.timer);
    this.listeners.clear();
  }
}
