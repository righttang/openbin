import { Camera, CheckCircle2, ChevronRight, ImagePlus, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { addBin, useBinList } from '@/features/bins/useBins';
import { useAuth } from '@/lib/auth';
import { useNavigationGuard } from '@/lib/navigationGuard';
import { useWarnOnUnload } from '@/lib/useWarnOnUnload';
import type { PhotoTask } from './automaticCaptureQueue';
import { useAutomaticCaptureQueue } from './useAutomaticCaptureQueue';

const inputClass = 'w-full rounded-xl border border-[var(--border-flat)] bg-[var(--bg-input)] px-3 py-3 text-base outline-none focus:ring-2 focus:ring-[var(--accent)]';
const labels: Record<PhotoTask['phase'], string> = {
  preparing: '正在准备照片', waiting: '等待上传', uploading: '上传中', recognizing: '已上传 · 识别中',
  done: '识别完成', failed: '需要重试', cancelling: '正在取消', cancelled: '已取消',
};

function TaskThumbnail({ task }: { task: PhotoTask }) {
  const [url, setUrl] = useState('');
  const [failedSource, setFailedSource] = useState('');
  const blob = task.photos[0]?.blob;
  const photoId = task.photos[0]?.id;
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  const preview = task.accepted && photoId && task.phase !== 'cancelled'
    ? `/api/captures/${encodeURIComponent(task.id)}/photos/${encodeURIComponent(photoId)}/preview` : '';
  const source = task.phase === 'done' && preview ? `${preview}?v=recognized` : url || preview;
  return source && source !== failedSource ? <img src={source} alt="本次拍摄" onError={() => setFailedSource(source)} className="h-16 w-16 shrink-0 rounded-lg bg-[var(--bg-active)] object-cover" />
    : <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-active)] text-[var(--text-tertiary)]"><Camera className="h-5 w-5" /></div>;
}

export function RemindMePage() {
  const { user, activeLocationId } = useAuth();
  const [params] = useSearchParams();
  const { setGuard } = useNavigationGuard();
  const { showToast } = useToast();
  const { bins, isLoading: binsLoading, refresh: refreshBins } = useBinList();
  const { queue, tasks, config, error: configError } = useAutomaticCaptureQueue(user?.id);
  const [binId, setBinId] = useState(() => params.get('place') || localStorage.getItem('remindme-selected-place') || '');
  const [newBinName, setNewBinName] = useState('');
  const [creating, setCreating] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [error, setError] = useState('');
  const cameraInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const recoverInput = useRef<HTMLInputElement>(null);
  const pickerPlace = useRef({ id: '', name: '' });
  const recoveryTask = useRef('');
  const unsafe = tasks.some((task) => !task.durable && task.phase !== 'cancelled');
  const pending = tasks.filter((task) => !task.accepted && task.phase !== 'cancelled').length;
  const recognizing = tasks.some((task) => task.phase === 'recognizing');
  const selectedBin = bins.find((bin) => bin.id === binId);
  useWarnOnUnload(pending > 0 || tasks.some((task) => task.phase === 'cancelling'));

  useEffect(() => {
    if (!binsLoading && (!binId || !bins.some((bin) => bin.id === binId))) setBinId(bins[0]?.id ?? '');
  }, [bins, binId, binsLoading]);
  useEffect(() => {
    if (binId) { try { localStorage.setItem('remindme-selected-place', binId); } catch { /* Selection remains in memory. */ } }
  }, [binId]);
  useEffect(() => {
    setGuard({ shouldBlock: () => unsafe, onBlocked: () => showToast({ message: '照片正在保存，请等上传完成或取消后再离开。', variant: 'warning' }) });
    return () => setGuard(null);
  }, [unsafe, setGuard, showToast]);

  function openPicker(camera: boolean) {
    if (!selectedBin || !queue) return;
    pickerPlace.current = { id: selectedBin.id, name: selectedBin.name };
    // Keep this synchronous: iOS requires the original tap to open its camera.
    (camera ? cameraInput : galleryInput).current?.click();
  }

  function selectPhotos(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length || !queue) return;
    setError('');
    try { queue.enqueue(files, pickerPlace.current.id ? pickerPlace.current : { id: binId, name: selectedBin?.name ?? '' }); }
    catch (err) { setError(err instanceof Error ? err.message : '无法添加照片，请重试。'); }
  }

  async function createPlace(event: React.FormEvent) {
    event.preventDefault();
    if (!activeLocationId || !newBinName.trim()) return;
    setCreatingBusy(true); setError('');
    try {
      const bin = await addBin({ name: newBinName.trim(), locationId: activeLocationId });
      setBinId(bin.id); setNewBinName(''); setCreating(false); refreshBins();
    } catch (err) { setError(err instanceof Error ? err.message : '地点创建失败。'); }
    finally { setCreatingBusy(false); }
  }

  const canShoot = !!queue && !!selectedBin && !!config?.modelConfigured;
  return <div className="mx-auto max-w-2xl">
    <header className="mb-7"><h1 className="text-3xl font-semibold tracking-tight">扫描</h1><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">拍一张，自动识别。可以接着拍下一张。</p></header>
    <section aria-label="拍照识别">
      <label htmlFor="capture-location" className="mb-2 block text-sm font-medium">地点</label>
      <select id="capture-location" className={inputClass} value={binId} onChange={(event) => setBinId(event.target.value)} disabled={binsLoading}>
        {!bins.length && <option value="">{binsLoading ? '加载中…' : '先添加一个地点'}</option>}
        {bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.name}</option>)}
      </select>
      <button type="button" onClick={() => setCreating(!creating)} className="mt-2 inline-flex items-center gap-1 py-1 text-sm text-[var(--accent)]"><Plus className="h-4 w-4" />添加地点</button>
      {creating && <form className="mt-2 flex gap-2" onSubmit={createPlace}><input aria-label="新地点名称" value={newBinName} onChange={(event) => setNewBinName(event.target.value)} placeholder="例如：书桌抽屉" className={inputClass} maxLength={100} required /><Button type="submit" disabled={creatingBusy || !activeLocationId || !newBinName.trim()}>添加</Button></form>}
      <input ref={cameraInput} aria-label="拍摄照片" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" className="hidden" onChange={(event) => selectPhotos(event.currentTarget)} />
      <input ref={galleryInput} aria-label="选择照片" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple className="hidden" onChange={(event) => selectPhotos(event.currentTarget)} />
      <input ref={recoverInput} aria-label="补回原照片" type="file" accept="image/*" multiple className="hidden" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void queue?.replaceMissing(recoveryTask.current, files); }} />
      <div className="mt-6 grid grid-cols-[1fr_auto] gap-3">
        <Button fullWidth className="min-h-16 text-lg" disabled={!canShoot} onClick={() => openPicker(true)}><Camera className="mr-2 h-6 w-6" />拍照</Button>
        <Button variant="outline" className="min-h-16 px-5" disabled={!canShoot} onClick={() => openPicker(false)}><ImagePlus className="mr-2 h-5 w-5" />选照片</Button>
      </div>
      <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">拍完自动上传识别，拍错可以取消。换地点后，新照片会记到新地点。</p>
      {config && !config.modelConfigured && <p className="mt-4 text-sm text-amber-700">识别服务暂时未就绪，请稍后重试。</p>}
      {(error || configError) && <p role="alert" className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error || configError}</p>}
      {tasks.length > 0 && <div className="mt-8">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">最近拍摄</h2><Link to="/history" className="inline-flex items-center gap-1 text-xs text-[var(--accent)]">全部历史<ChevronRight className="h-3.5 w-3.5" /></Link></div>
        <div aria-live="polite" className="mb-3 text-xs leading-5 text-[var(--text-secondary)]">
          {pending > 0 ? <p>还有 {pending} 次拍摄尚未上传完成，请保持页面打开，不要锁屏。可以继续拍照。</p>
            : recognizing ? <p>照片已上传。可以离开页面或锁屏，识别会在后台继续。</p> : <p>点击历史可查看识别结果与物品详情。</p>}
          {unsafe && <p className="text-amber-700 dark:text-amber-300">照片尚未完整保存在浏览器中，请等待上传完成。</p>}
        </div>
        <ul className="max-h-[26rem] divide-y divide-[var(--border-flat)] overflow-y-auto">{tasks.map((task, index) => <li key={task.id} className="flex items-start gap-3 py-3">
          {task.accepted && !task.cancelRequested ? <Link aria-label={`查看${task.binName || '地点'}的本次识别结果`} to={`/history?place=${encodeURIComponent(task.binId)}&capture=${encodeURIComponent(task.id)}`} className="shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><TaskThumbnail task={task} /></Link> : <TaskThumbnail task={task} />}
          <div className="min-w-0 flex-1 py-1"><p className="truncate text-sm font-medium">{task.binName || bins.find((bin) => bin.id === task.binId)?.name || '拍摄地点'}{task.photos.length > 1 ? ` · ${task.photos.length} 张` : ''}</p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">{['preparing', 'waiting', 'uploading', 'recognizing', 'cancelling'].includes(task.phase) && <Loader2 className="h-3 w-3 animate-spin" />}{task.phase === 'done' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}{task.cancelRequested && task.error ? '等待网络恢复后取消' : task.phase === 'failed' && task.accepted ? '识别失败，请重新拍摄' : labels[task.phase]}{task.phase === 'uploading' && task.photos.length > 1 ? ` ${task.received}/${task.photos.length}` : ''}</p>
            {task.accepted && !task.cancelRequested && <Link to={`/history?place=${encodeURIComponent(task.binId)}&capture=${encodeURIComponent(task.id)}`} className="mt-1 inline-block text-xs text-[var(--accent)]">查看本次结果</Link>}
            {task.error && <p role="alert" className="mt-1 text-xs leading-5 text-red-600 dark:text-red-300">{task.error}</p>}
            {(task.phase === 'failed' && !task.accepted || task.cancelRequested && !!task.error) && <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--accent)]" onClick={() => queue?.retry(task.id)}><RefreshCw className="h-3 w-3" />{task.cancelRequested ? '重试取消' : task.expired ? '重新上传' : '重试'}</button>}
            {task.phase === 'failed' && !task.accepted && task.photos.some((photo) => !photo.blob) && <button type="button" className="ml-3 mt-2 text-xs text-[var(--accent)]" onClick={() => { recoveryTask.current = task.id; recoverInput.current?.click(); }}>补回原照片</button>}
          </div>
          {!task.cancelRequested && <button type="button" aria-label={`取消${task.binName || bins.find((bin) => bin.id === task.binId)?.name || '地点'}的第 ${index + 1} 次拍摄`} title="取消这次拍摄并撤回本次识别结果" onClick={() => void queue?.cancel(task.id)} className="rounded-full p-3 text-[var(--text-tertiary)] hover:bg-red-500/10 hover:text-red-600"><X className="h-4 w-4" /></button>}
        </li>)}</ul>
      </div>}
    </section>
  </div>;
}
