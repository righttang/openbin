import { Camera, CheckCircle2, ChevronRight, ImagePlus, Loader2, Plus, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { addBin, useBinList } from '@/features/bins/useBins';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Events, notify } from '@/lib/eventBus';
import { useNavigationGuard } from '@/lib/navigationGuard';
import { useWarnOnUnload } from '@/lib/useWarnOnUnload';
import { captureClient, finishCapture, getCaptureConfig, hasAcceptedBatch } from './captureClient';
import { createCaptureId } from './captureCrypto';
import { clearDraft, loadDrafts, saveDraft } from './captureQueue';
import { displayCaptureDate as displayDate } from './ItemDetail';
import { preparePhoto } from './preparePhoto';
import type { Capture, CaptureConfig, CaptureDraft, LocalPhoto } from './types';

const inputClass = 'w-full rounded-xl border border-[var(--border-flat)] bg-[var(--bg-input)] px-3 py-3 text-base outline-none focus:ring-2 focus:ring-[var(--accent)]';
const statusLabels: Record<Capture['state'], string> = {
  uploading: '等待完整上传', queued: '已上传 · 等待识别', processing: '后台识别中',
  applied: '物品记录已更新', superseded: '已有更新的拍摄记录', failed: '识别失败，原有记录已保留', expired: '上传已过期',
};

function PhotoPreview({ photo, remove, locked }: { photo: LocalPhoto; remove: () => void; locked: boolean }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!photo.blob) { setUrl(''); return; }
    const objectUrl = URL.createObjectURL(photo.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo.blob]);
  return <div className="relative overflow-hidden rounded-xl border border-[var(--border-flat)]">
    {url ? <img className="aspect-square w-full object-cover" src={url} alt={`照片 ${photo.order + 1}：${photo.name}`} />
      : <div className="flex aspect-square items-center justify-center p-2 text-center text-xs text-[var(--text-secondary)]">本地照片缺失<br />重新选择原照片</div>}
    <span className="absolute bottom-1 left-1 rounded bg-black/65 px-1.5 py-0.5 text-xs text-white">{photo.order + 1}</span>
    {!locked && <button type="button" onClick={remove} aria-label={`移除照片 ${photo.order + 1}`} className="absolute right-1 top-1 rounded-full bg-black/60 p-2 text-white"><X className="h-4 w-4" /></button>}
  </div>;
}

export function RemindMePage() {
  const { user, activeLocationId } = useAuth();
  const [params] = useSearchParams();
  const { setGuard } = useNavigationGuard();
  const { showToast } = useToast();
  const { bins, isLoading: binsLoading, refresh: refreshBins } = useBinList();
  const [config, setConfig] = useState<CaptureConfig | null>(null);
  const [binId, setBinId] = useState(() => params.get('place') || localStorage.getItem('remindme-selected-place') || '');
  const [newBinName, setNewBinName] = useState('');
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CaptureDraft | null>(null);
  const [recoverable, setRecoverable] = useState<CaptureDraft[]>([]);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const recoverInput = useRef<HTMLInputElement>(null);
  const previousLocation = useRef(activeLocationId);
  const selectedBinId = useRef(binId);
  selectedBinId.current = binId;
  const captureId = capture?.id;
  const shouldPoll = !!capture && (['queued', 'processing'].includes(capture.state) || ['applied', 'superseded'].includes(capture.state) && !capture.cleanup_completed_at);
  const draftId = draft?.id;
  const draftExpiresAt = draft?.expiresAt;
  const pending = !!draft && !hasAcceptedBatch(capture ?? { state: 'uploading' } as Capture);
  useWarnOnUnload(pending && draft.photos.length > 0);

  useEffect(() => { getCaptureConfig().then(setConfig).catch(() => setError('无法读取拍摄设置，请刷新后重试。')); }, []);
  useEffect(() => {
    if (!user) return;
    let active = true;
    loadDrafts(user.id).then(async (drafts) => {
      const remaining: CaptureDraft[] = [];
      for (const saved of drafts) {
        try {
          const current = await captureClient.get(saved.id);
          if (hasAcceptedBatch(current) || current.state === 'expired') {
            await clearDraft(saved.id);
            continue;
          }
        } catch { /* Keep recoverable inputs until the server can acknowledge them. */ }
        remaining.push(saved);
      }
      if (active) setRecoverable(remaining);
    });
    return () => { active = false; };
  }, [user]);
  useEffect(() => {
    if (pending) return;
    if (previousLocation.current !== activeLocationId) {
      previousLocation.current = activeLocationId;
      setBinId(''); setCapture(null);
      return;
    }
    if (!binsLoading && (!binId || !bins.some((bin) => bin.id === binId))) setBinId(bins[0]?.id ?? '');
  }, [bins, binId, pending, activeLocationId, binsLoading]);

  useEffect(() => {
    if (binId) localStorage.setItem('remindme-selected-place', binId);
  }, [binId]);

  useEffect(() => {
    setGuard({
      shouldBlock: () => busy || (pending && storageWarning),
      onBlocked: () => showToast({ message: busy ? '正在处理照片，请完成后再离开。' : '当前照片未能保存在浏览器中，请先完成上传。', variant: 'warning' }),
    });
    return () => setGuard(null);
  }, [busy, pending, storageWarning, setGuard, showToast]);

  const refreshRecent = useCallback(async () => {
    if (!binId) return;
    const data = await apiFetch<{ captures: Capture[] }>(`/api/captures?bin_id=${encodeURIComponent(binId)}`);
    if (selectedBinId.current !== binId) return;
    setCapture((current) => current ?? data.captures.find((entry) => ['queued', 'processing'].includes(entry.state)) ?? null);
  }, [binId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: completed captures trigger a fresh history fetch
  useEffect(() => { refreshRecent().catch(() => {}); }, [refreshRecent, inventoryRevision]);
  useEffect(() => {
    if (!captureId || !shouldPoll) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await captureClient.get(captureId);
        if (!active) return;
        setCapture(next);
        if (!['queued', 'processing'].includes(next.state)) {
          setInventoryRevision((value) => value + 1);
          notify(Events.BINS);
          if (!['applied', 'superseded'].includes(next.state) || next.cleanup_completed_at) return;
        }
      } catch { /* Server jobs continue through browser disconnections. */ }
      if (active) timer = setTimeout(poll, 2500);
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [captureId, shouldPoll]);

  useEffect(() => {
    if (!draftId || !draftExpiresAt) return;
    let active = true;
    const timer = setTimeout(async () => {
      // Completion may have succeeded while its response was lost near the deadline.
      let accepted: Capture | null = null;
      try {
        const current = await captureClient.get(draftId);
        if (hasAcceptedBatch(current)) accepted = current;
      } catch { /* The local retention deadline still applies while offline. */ }
      if (!active) return;
      await clearDraft(draftId);
      if (active) {
        setRecoverable((entries) => entries.filter((entry) => entry.id !== draftId));
        setDraft((current) => current?.id === draftId ? null : current);
        setCapture((current) => accepted ?? (current?.id === draftId ? { ...current, state: 'expired' } : current));
        setError(accepted ? '' : '这批拍摄的上传期限已过，请开始新的拍摄。');
        setProgress(null);
      }
    }, Math.max(0, Date.parse(draftExpiresAt) - Date.now()));
    return () => { active = false; clearTimeout(timer); };
  }, [draftId, draftExpiresAt]);

  async function persist(next: CaptureDraft) {
    setDraft(next);
    const saved = await saveDraft(next);
    setStorageWarning(!saved);
    setRecoverable((entries) => [next, ...entries.filter((entry) => entry.id !== next.id)]);
  }

  async function createStorage(event: React.FormEvent) {
    event.preventDefault();
    if (!activeLocationId || !newBinName.trim()) return;
    setBusy(true); setError('');
    try {
      const bin = await addBin({ name: newBinName.trim(), locationId: activeLocationId });
      setBinId(bin.id); setNewBinName(''); setCreating(false); refreshBins();
    } catch (err) { setError(err instanceof Error ? err.message : '位置创建失败。'); }
    finally { setBusy(false); }
  }

  async function startCapture() {
    if (!binId || !user) return;
    setBusy(true); setError(''); setProgress(null);
    try {
      const id = createCaptureId();
      const next = await apiFetch<Capture>('/api/captures', { method: 'POST', body: {
        id, bin_id: binId, source: 'web', captured_at: new Date().toISOString(),
      } });
      setCapture(next);
      await persist({ id, ownerId: user.id, binId, createdAt: next.captured_at, expiresAt: next.expires_at, sealed: false, photos: [] });
    } catch (err) { setError(err instanceof Error ? err.message : '无法开始扫描，请检查网络。'); }
    finally { setBusy(false); }
  }

  async function resumeCapture(saved: CaptureDraft) {
    setBusy(true); setError(''); setProgress(null);
    try {
      const server = await captureClient.get(saved.id);
      setBinId(saved.binId); setCapture(server);
      if (hasAcceptedBatch(server) || server.state === 'expired') {
        await clearDraft(saved.id);
        setRecoverable((entries) => entries.filter((entry) => entry.id !== saved.id));
        setDraft(null);
      } else { setDraft(saved); }
    } catch (err) { setError(err instanceof Error ? err.message : '无法恢复，请检查网络后重试。'); }
    finally { setBusy(false); }
  }

  async function addFiles(files: FileList | null, recovering = false) {
    if (!files?.length || !draft || !config) return;
    setBusy(true); setError('');
    const updated = [...draft.photos];
    try {
      if (!recovering && updated.length + files.length > config.maxPhotos) throw new Error(`每批最多 ${config.maxPhotos} 张照片，请减少选择。`);
      for (const file of Array.from(files)) {
        const photo = await preparePhoto(file, config.maxPhotoBytes, updated.length);
        if (recovering) {
          const index = updated.findIndex((entry) => !entry.blob && entry.sha256 === photo.sha256);
          if (index === -1) throw new Error(`${file.name} 与缺失照片不匹配，请选择原照片。`);
          updated[index] = { ...updated[index], blob: photo.blob };
        } else if (!updated.some((entry) => entry.sha256 === photo.sha256)) updated.push(photo);
      }
    } catch (err) { setError(err instanceof Error ? err.message : '照片处理失败。'); }
    finally {
      await persist({ ...draft, photos: updated.map((photo, order) => ({ ...photo, order })) });
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
      if (cameraInput.current) cameraInput.current.value = '';
      if (recoverInput.current) recoverInput.current.value = '';
    }
  }

  async function upload() {
    if (!draft) return;
    setBusy(true); setError('');
    const sealed = { ...draft, sealed: true };
    await persist(sealed);
    try {
      const next = await finishCapture(sealed, captureClient, () => clearDraft(sealed.id),
        (received, total) => setProgress({ received, total }));
      setCapture(next); setDraft(null); setStorageWarning(false);
      setRecoverable((entries) => entries.filter((entry) => entry.id !== sealed.id));
      setInventoryRevision((value) => value + 1);
      notify(Events.BINS);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传中断。请保持此页面打开后重试。');
    } finally { setBusy(false); }
  }

  const selectedBin = bins.find((bin) => bin.id === (draft?.binId || binId));
  const accepted = capture && hasAcceptedBatch(capture);
  const canStart = !!config?.modelConfigured && !busy && !!binId && !pending;
  const missingPhotos = draft?.photos.some((photo) => !photo.blob);
  const visibleRecovery = recoverable.filter((entry) => entry.id !== draft?.id && bins.some((bin) => bin.id === entry.binId));

  return <div className="mx-auto max-w-2xl">
    <header className="mb-8">
      <h1 className="text-3xl font-semibold tracking-tight">扫描</h1>
      <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">选个地点，拍下物品。识别完成后就能查找。</p>
    </header>
    <section aria-label="拍照识别">
        <label htmlFor="capture-location" className="mb-2 block text-sm font-medium">地点</label>
        <select id="capture-location" className={inputClass} value={draft?.binId || binId} onChange={(event) => { setBinId(event.target.value); setCapture(null); }} disabled={pending || busy || binsLoading}>
          {!bins.length && <option value="">{binsLoading ? '加载中…' : '先添加一个地点'}</option>}
          {bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.name}</option>)}
        </select>
        {!pending && <button type="button" onClick={() => setCreating(!creating)} className="mt-2 inline-flex items-center gap-1 py-1 text-sm text-[var(--accent)]"><Plus className="h-4 w-4" />添加地点</button>}
        {creating && !pending && <form className="mt-2 flex gap-2" onSubmit={createStorage}><input aria-label="新地点名称" value={newBinName} onChange={(event) => setNewBinName(event.target.value)} placeholder="例如：书桌抽屉" className={inputClass} maxLength={100} required /><Button type="submit" disabled={busy || !activeLocationId || !newBinName.trim()}>添加</Button></form>}
        {!config?.modelConfigured && config && <p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-sm text-[var(--text-secondary)]">识别服务暂时未就绪，请稍后重试。</p>}

        {visibleRecovery.length > 0 && <div className="mt-4 space-y-2"><p className="text-sm font-medium">继续未完成的拍摄</p>{visibleRecovery.map((saved) => <button key={saved.id} type="button" disabled={busy || pending} onClick={() => resumeCapture(saved)} className="flex w-full items-center justify-between gap-2 rounded-xl border border-[var(--border-flat)] p-3 text-left text-sm"><span>{bins.find((bin) => bin.id === saved.binId)?.name} · {saved.photos.length} 张照片<br /><span className="text-xs text-[var(--text-secondary)]">{displayDate(saved.createdAt)}</span></span><ChevronRight className="h-4 w-4" /></button>)}</div>}

        {!pending && <div className="mt-5"><Button fullWidth onClick={startCapture} disabled={!canStart}><Camera className="mr-2 h-4 w-4" />{busy ? '正在准备…' : '开始新的拍摄'}</Button><p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">先拍一张全景，再补充细节。一次最多 {config?.maxPhotos ?? 20} 张。不同角度拍到的同一物品会自动合并。</p></div>}

        {pending && draft && <div className="mt-5 space-y-4">
          <div className="flex items-center justify-between text-sm"><span className="font-medium">本次扫描</span><span className="text-[var(--text-secondary)]">{draft.photos.length} / {config?.maxPhotos ?? 20} 张</span></div>
          <input ref={cameraInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" className="hidden" onChange={(event) => addFiles(event.target.files)} />
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple className="hidden" onChange={(event) => addFiles(event.target.files)} />
          <input ref={recoverInput} type="file" accept="image/*" multiple className="hidden" onChange={(event) => addFiles(event.target.files, true)} />
          {!draft.sealed && <div className="grid grid-cols-2 gap-2"><Button variant="outline" disabled={busy || draft.photos.length >= (config?.maxPhotos ?? 20)} onClick={() => cameraInput.current?.click()}><Camera className="mr-2 h-4 w-4" />拍照</Button><Button variant="outline" disabled={busy || draft.photos.length >= (config?.maxPhotos ?? 20)} onClick={() => fileInput.current?.click()}><ImagePlus className="mr-2 h-4 w-4" />选照片</Button></div>}
          {draft.photos.length > 0 ? <div className="grid grid-cols-4 gap-2">{draft.photos.map((photo) => <PhotoPreview key={photo.id} photo={photo} locked={busy || draft.sealed} remove={() => persist({ ...draft, photos: draft.photos.filter((entry) => entry.id !== photo.id).map((entry, order) => ({ ...entry, order })) })} />)}</div>
            : <div className="rounded-xl border border-dashed border-[var(--border-flat)] px-4 py-7 text-center text-sm leading-6 text-[var(--text-secondary)]">拍下 {selectedBin?.name ?? '这个位置'} 的全景<br />再添加能看清物品名称、型号的细节照片</div>}
          {missingPhotos && <div className="rounded-xl bg-amber-500/10 p-3 text-sm"><p>浏览器未保留部分照片。服务器已收到的照片可跳过；其余请重新选择原照片。</p><Button variant="outline" size="sm" className="mt-2" disabled={busy} onClick={() => recoverInput.current?.click()}>重新选择缺失照片</Button></div>}
          {storageWarning && <p aria-live="polite" className="text-sm text-amber-700 dark:text-amber-300">浏览器无法保存完整的恢复副本，请保持页面打开直到上传成功。</p>}
          {progress && <div aria-live="polite"><div className="mb-1 flex justify-between text-xs text-[var(--text-secondary)]"><span>{progress.received === progress.total ? '正在确认完整批次…' : '正在上传照片…'}</span><span>{progress.received} / {progress.total}</span></div><progress className="h-2 w-full accent-[var(--accent)]" value={progress.received} max={progress.total} /></div>}
          <Button fullWidth disabled={busy || draft.photos.length === 0} onClick={upload}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}{busy ? '处理中，请保持页面打开…' : draft.sealed ? '继续上传' : '结束拍摄并上传'}</Button>
          <p className="text-xs leading-5 text-[var(--text-secondary)]">上传完成前请保持此页面打开，不要锁屏。中断后可回到这里继续。识别后保留照片预览和物品裁剪图，可在历史记录中删除。</p>
          {!draft.photos.length && <button type="button" className="text-xs text-[var(--text-secondary)] underline" disabled={busy} onClick={async () => { await clearDraft(draft.id); setRecoverable((entries) => entries.filter((entry) => entry.id !== draft.id)); setDraft(null); setCapture(null); }}>暂不拍摄</button>}
        </div>}

        {error && <p role="alert" className="mt-4 rounded-xl bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
        {accepted && <div aria-live="polite" className="mt-5 rounded-xl border border-emerald-600/20 bg-emerald-500/10 p-4"><div className="flex items-center gap-2 font-medium"><CheckCircle2 className="h-5 w-5 text-emerald-600" />{statusLabels[capture.state]}</div><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{capture.state === 'failed' ? '本次未更新物品，可重新拍摄。临时照片将在保留期限内删除。' : capture.state === 'superseded' ? '较新的拍摄记录已生效，本批不会覆盖它。' : capture.state === 'applied' ? capture.cleanup_completed_at ? '物品已记录，照片预览和详情可在历史中查看。' : '物品已记录，照片详情正在整理。' : '整批照片已由服务器接收。可以离开页面或锁屏，识别会在后台继续。'}</p></div>}
        {accepted && <Link to={`/history?place=${encodeURIComponent(capture.bin_id)}`} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--accent)]">查看本次识别记录<ChevronRight className="h-4 w-4" /></Link>}
      </section>
  </div>;
}
