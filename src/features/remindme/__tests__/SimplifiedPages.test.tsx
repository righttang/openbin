import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import { FindPage } from '../FindPage';
import { HistoryPage } from '../HistoryPage';
import { PlacesPage } from '../PlacesPage';

const mocks = vi.hoisted(() => ({ api: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), restore: vi.fn(), refresh: vi.fn(),
  bins: [{ id: 'drawer', name: '书桌抽屉', area_name: '旧房间', items: [] }] }));
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ activeLocationId: 'home' }) }));
vi.mock('@/features/bins/useBins', () => ({
  useBinList: () => ({ bins: mocks.bins, isLoading: false, refresh: mocks.refresh }),
  addBin: (...args: unknown[]) => mocks.add(...args), updateBin: (...args: unknown[]) => mocks.update(...args),
  deleteBin: (...args: unknown[]) => mocks.remove(...args), restoreBin: (...args: unknown[]) => mocks.restore(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockResolvedValue({ items: [], photos: [] });
  mocks.add.mockResolvedValue(mocks.bins[0]);
  mocks.update.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(mocks.bins[0]);
  mocks.restore.mockResolvedValue(undefined);
});

describe('simple search', () => {
  it('starts with a search prompt instead of dumping all inventory or history', () => {
    render(<MemoryRouter><FindPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '查找' })).toBeInTheDocument();
    expect(screen.getByText('输入关键词，找到物品最后出现的地点。')).toBeInTheDocument();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '开始新的拍摄' })).not.toBeInTheDocument();
  });

  it('searches a flat place and opens cropped item details without legacy hierarchy', async () => {
    mocks.api.mockResolvedValue({ items: [{ id: 'scissors', name: '剪刀', description: '红色手柄', aliases: ['裁纸剪'], quantity: 1,
      bin_id: 'drawer', bin_name: '书桌抽屉', location_name: '旧家庭', area_name: '旧房间',
      last_seen_at: '2026-11-06T09:00:00Z', observation_state: 'seen', crop_url: '/crop.jpg' }] });
    render(<MemoryRouter initialEntries={['/find?place=drawer']}><FindPage /></MemoryRouter>);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索物品' }), { target: { value: '剪刀' } });
    fireEvent.click(await screen.findByRole('button', { name: '查看剪刀详情' }));
    const dialog = await screen.findByRole('dialog', { name: '剪刀' });
    expect(within(dialog).getByRole('img', { name: '剪刀的裁剪照片' })).toHaveAttribute('src', '/crop.jpg');
    expect(within(dialog).getByRole('link', { name: '书桌抽屉' })).toHaveAttribute('href', '/find?place=drawer');
    expect(screen.queryByText(/旧家庭|旧房间/)).not.toBeInTheDocument();
    const path = String(mocks.api.mock.calls[0][0]);
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('q')).toBe('剪刀');
    expect(params.get('bin_id')).toBe('drawer');
  });

  it('soft deletes only the selected item and restores it through the visible undo action', async () => {
    const item = { id: 'scissors', name: '剪刀', description: '', aliases: [], quantity: 1, bin_id: 'drawer', bin_name: '书桌抽屉', last_seen_at: null };
    mocks.api.mockImplementation((path: string) => Promise.resolve(path.includes('/bulk-') ? { deleted: 1, restored: 1 } : { items: [item] }));
    render(<MemoryRouter initialEntries={['/find?place=drawer']}><ToastProvider><FindPage /></ToastProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '删除物品剪刀' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/items/bulk-delete', { method: 'POST', body: { ids: ['scissors'] } }));
    expect(await screen.findByText('已删除“剪刀”')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: '查看剪刀详情' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/items/bulk-restore', { method: 'POST', body: { ids: ['scissors'] } }));
    expect(await screen.findByRole('button', { name: '查看剪刀详情' })).toBeInTheDocument();
  });

  it('keeps the item in search when its deletion fails', async () => {
    const item = { id: 'scissors', name: '剪刀', description: '', aliases: [], quantity: 1, bin_id: 'drawer', bin_name: '书桌抽屉', last_seen_at: null };
    mocks.api.mockImplementation((path: string) => path.includes('/bulk-delete') ? Promise.reject(new Error('offline')) : Promise.resolve({ items: [item] }));
    render(<MemoryRouter initialEntries={['/find?place=drawer']}><ToastProvider><FindPage /></ToastProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: '删除物品剪刀' }));
    expect(await screen.findByText('删除失败，物品仍保留，请重试。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看剪刀详情' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除物品剪刀' })).toBeEnabled();
  });
});

describe('flat place management', () => {
  it('adds and renames places without exposing household or area fields', async () => {
    render(<MemoryRouter><PlacesPage /></MemoryRouter>);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(screen.queryByText('旧房间')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '新地点名称' }), { target: { value: '厨房架子' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ name: '厨房架子', locationId: 'home' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '重命名书桌抽屉' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '重命名书桌抽屉' }));
    fireEvent.change(screen.getByRole('textbox', { name: '地点名称' }), { target: { value: '书桌左边抽屉' } });
    fireEvent.click(screen.getByRole('button', { name: '保存地点名称' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('drawer', { name: '书桌左边抽屉' }));
  });

  it('requires an explicit delete action and offers undo for the removed place', async () => {
    render(<MemoryRouter><PlacesPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '删除地点书桌抽屉' }));
    const dialog = await screen.findByRole('dialog', { name: '删除“书桌抽屉”？' });
    expect(mocks.remove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除地点' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('drawer'));
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }));
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(mocks.bins[0]));
  });
});

it('loads history across all places and allows a flat place filter', async () => {
  render(<MemoryRouter><HistoryPage /></MemoryRouter>);
  await waitFor(() => expect(mocks.api).toHaveBeenCalled());
  const first = new URLSearchParams(String(mocks.api.mock.calls[0][0]).split('?')[1]);
  expect(first.get('location_id')).toBe('home');
  expect(first.has('bin_id')).toBe(false);
  fireEvent.change(screen.getByRole('combobox', { name: '历史地点' }), { target: { value: 'drawer' } });
  await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => String(path).includes('bin_id=drawer'))).toBe(true));
  expect(screen.queryByRole('textbox', { name: '搜索物品' })).not.toBeInTheDocument();
});
