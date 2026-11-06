import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CaptureConfig } from '../types';
import { useAutomaticCaptureQueue } from '../useAutomaticCaptureQueue';

const mocks = vi.hoisted(() => ({ config: vi.fn(), load: vi.fn(), save: vi.fn(), clear: vi.fn(), list: vi.fn(), cancel: vi.fn() }));
vi.mock('../captureClient', async (original) => ({ ...await original<typeof import('../captureClient')>(),
  getCaptureConfig: () => mocks.config(), automaticCaptureClient: { list: () => mocks.list(), cancel: (...args: unknown[]) => mocks.cancel(...args) },
}));
vi.mock('../captureQueue', () => ({ loadDrafts: (...args: unknown[]) => mocks.load(...args), saveDraft: (...args: unknown[]) => mocks.save(...args), clearDraft: (...args: unknown[]) => mocks.clear(...args) }));
const config: CaptureConfig = { maxPhotos: 20, maxPhotoBytes: 5000000, uploadExpiryMs: 3600000, modelConfigured: true, supportedMimeTypes: ['image/jpeg'] };

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mocks.load.mockResolvedValue([]); mocks.list.mockResolvedValue([]); mocks.save.mockResolvedValue(true); mocks.clear.mockResolvedValue(undefined); });
afterEach(() => { localStorage.clear(); });

it('restores cancellation intents while the configuration request is still offline', async () => {
  let resolve!: (value: CaptureConfig) => void;
  mocks.config.mockImplementation(() => new Promise<CaptureConfig>((yes) => { resolve = yes; }));
  mocks.load.mockResolvedValue([{ id: 'cancelled-photo', ownerId: 'offline-owner', binId: 'drawer', binName: '抽屉', createdAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T01:00:00Z', sealed: true, cancelRequested: true, photos: [] }]);
  mocks.cancel.mockRejectedValue(new Error('离线'));
  const { result } = renderHook(() => useAutomaticCaptureQueue('offline-owner'));
  await waitFor(() => expect(result.current.tasks[0]?.phase).toBe('cancelling'));
  expect(mocks.load).toHaveBeenCalledWith('offline-owner');
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('cancelled-photo', 'drawer'));
  expect(result.current.tasks[0].error).toContain('取消尚未同步');
  expect(mocks.clear).not.toHaveBeenCalled();
  await act(async () => resolve(config));
});

it('loads cached settings and automatically refreshes them on reconnect', async () => {
  localStorage.setItem('remindme-capture-config', JSON.stringify(config));
  mocks.config.mockRejectedValueOnce(new Error('离线')).mockResolvedValue(config);
  const { result } = renderHook(() => useAutomaticCaptureQueue('cached-owner'));
  expect(result.current.config?.modelConfigured).toBe(true);
  await waitFor(() => expect(result.current.error).toContain('恢复联网后'));
  await act(async () => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(result.current.error).toBe(''));
  expect(mocks.config).toHaveBeenCalledTimes(2);
});
