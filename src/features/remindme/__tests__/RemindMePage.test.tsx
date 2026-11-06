import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhotoTask } from '../automaticCaptureQueue';
import { RemindMePage } from '../RemindMePage';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), cancel: vi.fn(), retry: vi.fn(), replaceMissing: vi.fn(),
  tasks: [] as PhotoTask[], bins: [{ id: 'drawer', name: '抽屉 A' }, { id: 'shelf', name: '架子 B' }] }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'owner' }, activeLocationId: 'home' }) }));
vi.mock('@/features/bins/useBins', () => ({ useBinList: () => ({ bins: mocks.bins, isLoading: false, refresh: vi.fn() }), addBin: vi.fn() }));
vi.mock('../useAutomaticCaptureQueue', () => ({ useAutomaticCaptureQueue: () => ({
  queue: { enqueue: mocks.enqueue, cancel: mocks.cancel, retry: mocks.retry, replaceMissing: mocks.replaceMissing },
  tasks: mocks.tasks, config: { modelConfigured: true }, error: '',
}) }));

function task(extra: Partial<PhotoTask> = {}): PhotoTask {
  return { id: 'capture', binId: 'drawer', binName: '抽屉 A', createdAt: new Date().toISOString(), phase: 'uploading', photos: [],
    accepted: false, durable: true, error: '', received: 0, cancelRequested: false, expired: false, ...extra };
}
beforeEach(() => { vi.clearAllMocks(); mocks.tasks = []; localStorage.clear(); });
const page = () => <MemoryRouter><RemindMePage /></MemoryRouter>;

describe('one tap camera', () => {
  it('opens the camera synchronously without creating a server capture first', async () => {
    render(page());
    const button = screen.getByRole('button', { name: '拍照' });
    await waitFor(() => expect(button).toBeEnabled());
    const camera = screen.getByLabelText('拍摄照片') as HTMLInputElement;
    const click = vi.spyOn(camera, 'click');
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    expect(camera).toHaveAttribute('capture', 'environment');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /开始新的拍摄|结束拍摄并上传/ })).not.toBeInTheDocument();
  });

  it('automatically queues a returned photo at the place selected when the camera opened', async () => {
    render(page());
    const button = screen.getByRole('button', { name: '拍照' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: 'shelf' } });
    const camera = screen.getByLabelText('拍摄照片') as HTMLInputElement;
    const photo = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });
    fireEvent.change(camera, { target: { files: [photo] } });
    expect(mocks.enqueue).toHaveBeenCalledWith([photo], { id: 'drawer', name: '抽屉 A' });
    expect(camera.value).toBe('');
    expect(button).toBeEnabled();
  });

  it('keeps camera and place selection enabled while earlier photos prepare, upload or recognize', async () => {
    mocks.tasks = [task({ id: 'one', phase: 'preparing', durable: false }), task({ id: 'two' }), task({ id: 'three', phase: 'recognizing', accepted: true })];
    render(page());
    await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '选照片' })).toBeEnabled();
    expect(screen.getByLabelText('地点')).toBeEnabled();
    expect(screen.getByText(/尚未上传完成，请保持页面打开/)).toBeInTheDocument();
  });

  it('does nothing when the camera is dismissed without a photo', async () => {
    render(page());
    await waitFor(() => expect(screen.getByRole('button', { name: '拍照' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '拍照' }));
    fireEvent.change(screen.getByLabelText('拍摄照片'), { target: { files: [] } });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('only allows leaving and locking the phone after acknowledgement', () => {
    mocks.tasks = [task()];
    const { rerender } = render(page());
    expect(screen.queryByText(/可以离开页面或锁屏/)).not.toBeInTheDocument();
    mocks.tasks = [task({ phase: 'recognizing', accepted: true })];
    rerender(page());
    expect(screen.getByText(/可以离开页面或锁屏/)).toBeInTheDocument();
  });

  it('cancels individual photos and distinguishes unsynced cancellation from recognition failure', () => {
    mocks.tasks = [task(), task({ id: 'offline', phase: 'cancelling', cancelRequested: true, error: '取消尚未同步：离线' }), task({ id: 'failed', phase: 'failed', accepted: true, error: '模型未完成' })];
    render(page());
    fireEvent.click(screen.getByRole('button', { name: '取消抽屉 A的第 1 次拍摄' }));
    expect(mocks.cancel).toHaveBeenCalledWith('capture');
    expect(screen.getByText('等待网络恢复后取消')).toBeInTheDocument();
    expect(screen.getByText('识别失败，请重新拍摄')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试取消' }));
    expect(mocks.retry).toHaveBeenCalledWith('offline');
  });
});
