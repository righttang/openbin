import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemDetail, type ItemDetailData } from '../ItemDetail';
import { PhotoHistory } from '../PhotoHistory';
import type { PhotoHistory as PhotoHistoryRecord } from '../types';

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), changed: vi.fn(), deleted: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast: mocks.toast }) }));

const first: PhotoHistoryRecord = {
  capture_id: 'batch', photo_id: 'photo-a', bin_id: 'drawer', bin_name: '抽屉 A',
  captured_at: '2026-11-06T09:00:00Z', state: 'applied', sequence: 1, error_category: null,
  preview_url: '/api/captures/batch/photos/photo-a/preview',
  items: [{ observation_id: 'obs-a', item_id: 'item-a', name: '剪刀', description: '红色手柄的剪刀',
    aliases: ['裁纸剪'], quantity: 1, crop_url: '/api/captures/observations/obs-a/photos/photo-a/crop' }],
};
const second: PhotoHistoryRecord = { ...first, photo_id: 'photo-b', preview_url: null,
  items: [{ observation_id: 'obs-b', item_id: 'item-b', name: '电池', description: '部分被遮挡', aliases: [], quantity: null, crop_url: null }],
};

function Page() {
  const [item, setItem] = useState<ItemDetailData | null>(null);
  return <MemoryRouter><PhotoHistory binId="drawer" locationId="household" refreshKey={0}
    onResultsChanged={mocks.changed} onDeleted={mocks.deleted} onSelectItem={setItem} />
    <ItemDetail item={item} onClose={() => setItem(null)} />
  </MemoryRouter>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockResolvedValue({ photos: [first, second] });
});

describe('photo grouped recognition history', () => {
  it('keeps each photo result separate and opens an actual item crop with details', async () => {
    render(<Page />);
    const one = await screen.findByRole('article', { name: '照片记录 1：抽屉 A' });
    const two = screen.getByRole('article', { name: '照片记录 2：抽屉 A' });
    expect(within(one).getByText('剪刀')).toBeInTheDocument();
    expect(within(one).queryByText('电池')).not.toBeInTheDocument();
    expect(within(two).getByText('电池')).toBeInTheDocument();
    expect(within(two).queryByText('剪刀')).not.toBeInTheDocument();
    fireEvent.click(within(one).getByRole('button', { name: '查看剪刀详情' }));
    const dialog = await screen.findByRole('dialog', { name: '剪刀' });
    expect(within(dialog).getByRole('img', { name: '剪刀的裁剪照片' })).toHaveAttribute('src', first.items[0].crop_url);
    expect(within(dialog).getByText('红色手柄的剪刀')).toBeInTheDocument();
    expect(within(dialog).getByText('裁纸剪')).toBeInTheDocument();
    expect(within(dialog).getByText('数量 1')).toBeInTheDocument();
  });

  it('deletes only the selected photo record and tells the parent to refresh inventory', async () => {
    let finish!: () => void;
    mocks.api.mockImplementation((_path: string, options?: { method: string }) => options?.method === 'DELETE'
      ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve({ photos: [first, second] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: '删除照片记录 1' }));
    expect(screen.getByRole('button', { name: '删除照片记录 1' })).toBeDisabled();
    expect(mocks.deleted).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(mocks.api).toHaveBeenCalledWith('/api/captures/batch/photos/photo-a/history', { method: 'DELETE' });
    expect(mocks.deleted).toHaveBeenCalledWith('batch');
    expect(screen.queryByRole('button', { name: '查看剪刀详情' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看电池详情' })).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  });

  it('retains the photo record when deletion fails', async () => {
    mocks.api.mockImplementation((_path: string, options?: { method: string }) => options?.method === 'DELETE'
      ? Promise.reject(new Error('offline')) : Promise.resolve({ photos: [first] }));
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: '删除照片记录 1' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error' })));
    expect(screen.getByRole('button', { name: '查看剪刀详情' })).toBeInTheDocument();
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it('shows legacy text results and unknown counts without pretending to have a crop', async () => {
    mocks.api.mockResolvedValue({ photos: [second] });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: '查看电池详情' }));
    const dialog = await screen.findByRole('dialog', { name: '电池' });
    expect(within(dialog).getByText('数量未知')).toBeInTheDocument();
    expect(within(dialog).getByText('这条记录暂无图片')).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
  });

  it('labels the original preview honestly if an item has no crop', async () => {
    mocks.api.mockResolvedValue({ photos: [{ ...first, items: [{ ...first.items[0], crop_url: null }] }] });
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: '查看剪刀详情' }));
    const dialog = await screen.findByRole('dialog', { name: '剪刀' });
    expect(within(dialog).getByRole('img', { name: '剪刀所在的原照片预览' })).toHaveAttribute('src', first.preview_url);
    expect(within(dialog).getByText(/这件物品暂无裁剪图/)).toBeInTheDocument();
  });

  it('refreshes pending groups until the item results arrive', async () => {
    mocks.api.mockResolvedValueOnce({ photos: [{ ...first, state: 'processing', items: [] }] })
      .mockResolvedValue({ photos: [first] });
    render(<Page />);
    expect(await screen.findByText('识别中')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看剪刀详情' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '查看剪刀详情' }, { timeout: 3500 })).toBeInTheDocument();
    expect(mocks.changed).toHaveBeenCalledOnce();
  });
});
