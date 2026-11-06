import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemindMePage } from '../RemindMePage';
import type { Capture } from '../types';

const mocks = vi.hoisted(() => ({
  user: { id: 'owner' }, bins: [{ id: 'drawer', name: '抽屉 A', area_name: '书房' }],
  api: vi.fn(), get: vi.fn(), upload: vi.fn(), complete: vi.fn(), config: vi.fn(),
  save: vi.fn(), load: vi.fn(), clear: vi.fn(), prepare: vi.fn(), refresh: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: mocks.user, activeLocationId: 'household' }) }));
vi.mock('@/features/locations/useLocations', () => ({ useActiveLocation: () => ({ name: 'Home' }) }));
vi.mock('@/features/bins/useBins', () => ({ useBinList: () => ({ bins: mocks.bins, isLoading: false, refresh: mocks.refresh }), addBin: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }));
vi.mock('../captureClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../captureClient')>(),
  captureClient: { get: (...args: unknown[]) => mocks.get(...args), upload: (...args: unknown[]) => mocks.upload(...args), complete: (...args: unknown[]) => mocks.complete(...args) },
  getCaptureConfig: () => mocks.config(),
}));
vi.mock('../captureQueue', () => ({ saveDraft: (...args: unknown[]) => mocks.save(...args), loadDrafts: (...args: unknown[]) => mocks.load(...args), clearDraft: (...args: unknown[]) => mocks.clear(...args) }));
vi.mock('../preparePhoto', () => ({ preparePhoto: (...args: unknown[]) => mocks.prepare(...args) }));

const capture: Capture = {
  id: 'capture', bin_id: 'drawer', sequence: 1, state: 'uploading', captured_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(), received_at: null, cleanup_completed_at: null, photos: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockImplementation((path: string) => {
    if (path === '/api/captures') return Promise.resolve(capture);
    if (path.startsWith('/api/captures/inventory')) return Promise.resolve({ items: [] });
    return Promise.resolve({ captures: [] });
  });
  mocks.config.mockResolvedValue({ maxPhotos: 20, maxPhotoBytes: 5 * 1024 * 1024, modelConfigured: true });
  mocks.save.mockResolvedValue(true);
  mocks.load.mockResolvedValue([]);
  mocks.clear.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue(capture);
  mocks.upload.mockResolvedValue({});
  mocks.complete.mockResolvedValue({ ...capture, state: 'queued' });
  mocks.prepare.mockResolvedValue({ id: 'photo', sha256: 'hash', size: 5, order: 0, name: 'drawer.jpg', blob: new Blob(['image'], { type: 'image/jpeg' }) });
});

async function beginAndAddPhoto() {
  render(<MemoryRouter><RemindMePage /></MemoryRouter>);
  const start = await screen.findByRole('button', { name: '开始新的拍摄' });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await screen.findByRole('button', { name: '拍照' });
  const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
  fireEvent.change(input, { target: { files: [new File(['image'], 'drawer.jpg', { type: 'image/jpeg' })] } });
  await waitFor(() => expect(screen.getByRole('button', { name: '结束拍摄并上传' })).toBeEnabled());
}

describe('capture page acknowledgement messaging', () => {
  it('keeps the phone-open warning until the entire manifest is acknowledged', async () => {
    let accept!: (result: Capture) => void;
    mocks.complete.mockReturnValue(new Promise<Capture>((resolve) => { accept = resolve; }));
    await beginAndAddPhoto();
    fireEvent.click(screen.getByRole('button', { name: '结束拍摄并上传' }));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    expect(screen.getByText(/上传完成前请保持此页面打开/)).toBeInTheDocument();
    expect(screen.queryByText(/可以离开页面或锁屏/)).not.toBeInTheDocument();
    expect(mocks.clear).not.toHaveBeenCalled();
    await act(async () => accept({ ...capture, state: 'queued' }));
    expect(await screen.findByText(/可以离开页面或锁屏/)).toBeInTheDocument();
    expect(mocks.clear).toHaveBeenCalledWith(mocks.complete.mock.calls[0][0]);
  });

  it('offers an upload retry without a success message after the network drops', async () => {
    mocks.upload.mockRejectedValue(new Error('网络连接中断'));
    await beginAndAddPhoto();
    fireEvent.click(screen.getByRole('button', { name: '结束拍摄并上传' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络连接中断');
    expect(screen.getByRole('button', { name: '继续上传' })).toBeEnabled();
    expect(screen.queryByText(/可以离开页面或锁屏/)).not.toBeInTheDocument();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('clears browser photos on reopening when the server has already accepted them', async () => {
    mocks.load.mockResolvedValue([{ id: 'capture', ownerId: 'owner', binId: 'drawer', createdAt: capture.captured_at, expiresAt: capture.expires_at, sealed: true, photos: [] }]);
    mocks.get.mockResolvedValue({ ...capture, state: 'processing' });
    render(<MemoryRouter><RemindMePage /></MemoryRouter>);
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith('capture'));
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(screen.queryByText('继续未完成的拍摄')).not.toBeInTheDocument();
  });

  it('resumes watching a server job on reopening and shows automatic completion', async () => {
    mocks.api.mockImplementation((path: string) => Promise.resolve(path.startsWith('/api/captures/inventory')
      ? { items: [] } : { captures: [{ ...capture, state: 'processing' }] }));
    mocks.get.mockResolvedValue({ ...capture, state: 'applied', cleanup_completed_at: new Date().toISOString() });
    render(<MemoryRouter><RemindMePage /></MemoryRouter>);
    expect(await screen.findByText(/可以离开页面或锁屏/)).toBeInTheDocument();
    expect(await screen.findByText('物品已记录，照片预览和详情可在识别历史中查看。', {}, { timeout: 2500 })).toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('allows a new capture after the current upload expires', async () => {
    const expired = { ...capture, expires_at: new Date(Date.now() - 1000).toISOString() };
    mocks.api.mockImplementation((path: string) => Promise.resolve(path === '/api/captures' ? expired
      : path.startsWith('/api/captures/inventory') ? { items: [] } : { captures: [] }));
    render(<MemoryRouter><RemindMePage /></MemoryRouter>);
    const start = await screen.findByRole('button', { name: '开始新的拍摄' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    expect(await screen.findByRole('alert')).toHaveTextContent('上传期限已过');
    expect(screen.getByRole('button', { name: '开始新的拍摄' })).toBeEnabled();
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it('opens search-item crops and refreshes inventory after its photo history is deleted', async () => {
    let removed = false;
    const item = { id: 'scissors', name: '剪刀', description: '红色手柄', aliases: ['裁纸剪'], quantity: 1,
      bin_id: 'drawer', bin_name: '抽屉 A', location_name: '家', area_name: null,
      last_seen_at: capture.captured_at, observation_state: 'seen',
      crop_url: '/api/captures/observations/obs/photos/photo/crop', photo_preview_url: '/api/captures/capture/photos/photo/preview' };
    const photo = { capture_id: 'capture', photo_id: 'photo', bin_id: 'drawer', bin_name: '抽屉 A',
      captured_at: capture.captured_at, state: 'applied', sequence: 1, error_category: null,
      preview_url: item.photo_preview_url, items: [{ observation_id: 'obs', item_id: item.id, name: item.name,
        description: item.description, aliases: item.aliases, quantity: item.quantity, crop_url: item.crop_url }] };
    mocks.api.mockImplementation((path: string, options?: { method: string }) => {
      if (options?.method === 'DELETE') { removed = true; return Promise.resolve({ removed: true, removed_items: 1 }); }
      if (path.startsWith('/api/captures/history')) return Promise.resolve({ photos: removed ? [] : [photo] });
      if (path.startsWith('/api/captures/inventory')) return Promise.resolve({ items: removed ? [] : [item] });
      return Promise.resolve({ captures: [] });
    });
    render(<MemoryRouter><RemindMePage /></MemoryRouter>);
    const inventory = screen.getByRole('region', { name: '东西放在哪？' });
    fireEvent.click(await within(inventory).findByRole('button', { name: '查看剪刀详情' }));
    const dialog = await screen.findByRole('dialog', { name: '剪刀' });
    expect(within(dialog).getByRole('img', { name: '剪刀的裁剪照片' })).toHaveAttribute('src', item.crop_url);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: '删除照片记录 1' }));
    await waitFor(() => expect(within(inventory).queryByRole('button', { name: '查看剪刀详情' })).not.toBeInTheDocument());
    expect(screen.queryByRole('article', { name: '照片记录 1：抽屉 A' })).not.toBeInTheDocument();
    expect(removed).toBe(true);
  });
});
