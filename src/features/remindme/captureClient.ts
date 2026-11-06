import { ApiError, apiFetch, readCsrfTokenFromCookie, tryRefresh } from '@/lib/api';
import type { Capture, CaptureConfig, CaptureDraft, CapturePhoto, LocalPhoto } from './types';

export interface CaptureClient {
  get(id: string): Promise<Capture>;
  upload(id: string, photo: LocalPhoto): Promise<unknown>;
  complete(id: string, photos: CapturePhoto[]): Promise<Capture>;
}

async function uploadPhoto(id: string, photo: LocalPhoto, retry = true): Promise<unknown> {
  if (!photo.blob) throw new Error(`请重新选择缺失的照片：${photo.name}`);
  const csrf = readCsrfTokenFromCookie();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let response: Response;
  try {
    response = await fetch(`/api/captures/${encodeURIComponent(id)}/photos/${encodeURIComponent(photo.id)}`, {
      method: 'PUT', credentials: 'same-origin', body: photo.blob, signal: controller.signal,
      headers: {
        'Content-Type': photo.blob.type,
        'X-Photo-SHA256': photo.sha256,
        'X-Photo-Size': String(photo.size),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      },
    });
  } finally { clearTimeout(timer); }
  if (response.status === 401 && retry && await tryRefresh()) return uploadPhoto(id, photo, false);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.message || '照片上传失败，请保持页面打开后重试。');
  return data;
}

export const captureClient: CaptureClient = {
  get: (id) => apiFetch(`/api/captures/${encodeURIComponent(id)}`),
  upload: uploadPhoto,
  complete: (id, photos) => apiFetch(`/api/captures/${encodeURIComponent(id)}/complete`, {
    method: 'POST', body: { photos }, timeout: 30_000,
  }),
};

export const getCaptureConfig = () => apiFetch<CaptureConfig>('/api/captures/config');

export function hasAcceptedBatch(capture: Capture): boolean {
  return ['queued', 'processing', 'applied', 'superseded', 'failed'].includes(capture.state);
}

function manifest(photos: LocalPhoto[]): CapturePhoto[] {
  return photos.map(({ id, sha256, size, order }) => ({ id, sha256, size, order }));
}

/** Local photos must survive every failure, including a lost completion response. */
export async function finishCapture(
  draft: CaptureDraft,
  client: CaptureClient,
  clearLocal: () => Promise<void>,
  onProgress: (received: number, total: number) => void,
): Promise<Capture> {
  const current = await client.get(draft.id);
  if (hasAcceptedBatch(current)) {
    await clearLocal();
    return current;
  }
  if (current.state !== 'uploading') throw new Error('这批拍摄已过期，请开始新的拍摄。');
  if (!draft.photos.length) throw new Error('请先添加照片。');
  const received = new Map(current.photos.map((photo) => [photo.id, photo]));
  let done = 0;
  onProgress(done, draft.photos.length);
  for (const photo of draft.photos) {
    const existing = received.get(photo.id);
    if (existing && existing.sha256 !== photo.sha256) throw new Error('照片校验信息冲突，未提交本批拍摄。');
    if (!existing?.received_at) await client.upload(draft.id, photo);
    onProgress(++done, draft.photos.length);
  }
  const accepted = await client.complete(draft.id, manifest(draft.photos));
  if (!hasAcceptedBatch(accepted)) throw new Error('服务器尚未接收完整批次，请保持页面打开并重试。');
  await clearLocal();
  return accepted;
}
