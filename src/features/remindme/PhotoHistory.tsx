import { CheckCircle2, ChevronRight, Clock3, ImageOff, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiFetch } from '@/lib/api';
import { displayCaptureDate, type ItemDetailData } from './ItemDetail';
import type { PhotoHistory as PhotoHistoryRecord } from './types';

interface PhotoHistoryProps {
  binId: string;
  locationId: string | null;
  refreshKey: number;
  onResultsChanged: () => void;
  onDeleted: (captureId: string) => void;
  onSelectItem: (item: ItemDetailData) => void;
  compactHeading?: boolean;
}

const inProgress = (state: PhotoHistoryRecord['state']) => ['uploading', 'queued', 'processing'].includes(state);
const photoKey = (photo: PhotoHistoryRecord) => `${photo.capture_id}/${photo.photo_id}`;
const labels: Record<PhotoHistoryRecord['state'], string> = {
  uploading: '待上传完成', queued: '等待识别', processing: '识别中', applied: '识别完成',
  superseded: '历史识别结果', failed: '识别失败', expired: '上传已过期',
};

function Preview({ photo }: { photo: PhotoHistoryRecord }) {
  const [failed, setFailed] = useState(false);
  return photo.preview_url && !failed
    ? <img src={photo.preview_url} loading="lazy" alt={`${photo.bin_name}的拍摄照片`} className="aspect-[4/3] w-full bg-[var(--bg-active)] object-contain" onError={() => setFailed(true)} />
    : <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-[var(--bg-active)] p-4 text-center text-xs text-[var(--text-secondary)]"><ImageOff className="h-7 w-7 text-[var(--text-tertiary)]" /><span>暂无照片预览</span><span>{inProgress(photo.state) ? '照片上传后显示预览' : '照片未保留或已清理，文字结果仍可查看'}</span></div>;
}

export function PhotoHistory({ binId, locationId, refreshKey, onResultsChanged, onDeleted, onSelectItem, compactHeading = false }: PhotoHistoryProps) {
  const [photos, setPhotos] = useState<PhotoHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const removed = useRef(new Set<string>());
  const previousSignature = useRef('');
  const previousScope = useRef('');
  const { showToast } = useToast();

  // Each polling request belongs to this selected location, never to an old selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: upload completion and deletion explicitly refresh history
  useEffect(() => {
    if (!locationId) { setPhotos([]); setLoading(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const scope = `${locationId}/${binId}`;
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      previousSignature.current = '';
      setPhotos([]);
    }
    setLoading(true);
    const fetchHistory = async () => {
      try {
        const params = new URLSearchParams({ location_id: locationId });
        if (binId) params.set('bin_id', binId);
        const data = await apiFetch<{ photos: PhotoHistoryRecord[] }>(`/api/captures/history?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const next = (data.photos ?? []).filter((photo) => !removed.current.has(photoKey(photo)));
        const signature = JSON.stringify(next.map((photo) => [photoKey(photo), photo.state, photo.items.map((item) => item.observation_id)]));
        if (previousSignature.current && previousSignature.current !== signature) onResultsChanged();
        previousSignature.current = signature;
        setPhotos(next); setError('');
        if (next.some((photo) => inProgress(photo.state))) timer = setTimeout(fetchHistory, 2500);
      } catch {
        if (controller.signal.aborted) return;
        setError('识别历史暂时无法加载，请重试。');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void fetchHistory();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [binId, locationId, refreshKey, retry, onResultsChanged]);

  const remove = useCallback(async (photo: PhotoHistoryRecord) => {
    const key = photoKey(photo);
    setDeleting((keys) => [...keys, key]);
    try {
      await apiFetch(`/api/captures/${encodeURIComponent(photo.capture_id)}/photos/${encodeURIComponent(photo.photo_id)}/history`, { method: 'DELETE' });
      removed.current.add(key);
      setPhotos((current) => current.filter((entry) => photoKey(entry) !== key));
      onDeleted(photo.capture_id);
      showToast({ message: '已删除照片记录及其独有结果，其他记录中的物品已保留。', variant: 'success' });
    } catch {
      showToast({ message: '删除失败，照片记录仍然保留，请重试。', variant: 'error' });
    } finally { setDeleting((keys) => keys.filter((entry) => entry !== key)); }
  }, [onDeleted, showToast]);

  return <section className="min-w-0" aria-labelledby={compactHeading ? undefined : 'photo-history-heading'} aria-label={compactHeading ? '照片识别历史' : undefined}>
    <div className="mb-5 flex items-start justify-between gap-3">
      <div>{!compactHeading && <h2 id="photo-history-heading" className="flex items-center gap-2 text-lg font-semibold"><Clock3 className="h-5 w-5 text-[var(--accent)]" />照片识别历史</h2>}<p className="mt-1.5 text-xs leading-5 text-[var(--text-secondary)]">点叉删除照片记录及其独有结果，其他照片里的物品会保留。</p></div>
      <button type="button" aria-label="刷新识别历史" title="刷新识别历史" className="shrink-0 rounded-lg p-2 text-[var(--text-secondary)] hover:bg-[var(--bg-active)]" onClick={() => setRetry((value) => value + 1)}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
    </div>
    {error && <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-sm text-red-600"><span>{error}</span><Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>重试</Button></div>}
    {loading && photos.length === 0 ? <p className="py-6 text-center text-sm text-[var(--text-secondary)]">正在加载识别历史…</p>
      : photos.length === 0 && !error ? <p className="rounded-xl border border-dashed border-[var(--border-flat)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">还没有照片记录。拍摄并上传后，在这里查看每张照片识别出了什么。</p>
        : <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">{photos.map((photo, index) => {
          const key = photoKey(photo);
          const isDeleting = deleting.includes(key);
          return <article key={key} aria-label={`照片记录 ${index + 1}：${photo.bin_name}`} className="min-w-0 overflow-hidden rounded-xl border border-[var(--border-flat)]">
            <div className="relative"><Preview key={photo.preview_url} photo={photo} />
              <button type="button" aria-label={`删除照片记录 ${index + 1}`} title="删除这张照片记录及其独有的识别结果" disabled={isDeleting} onClick={() => void remove(photo)} className="absolute right-2 top-2 rounded-full bg-black/65 p-2.5 text-white shadow-sm hover:bg-black/80 disabled:opacity-50">{isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}</button>
            </div>
            <div className="p-4"><div className="flex items-center justify-between gap-2 text-xs"><span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">{inProgress(photo.state) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : photo.state === 'applied' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : null}{labels[photo.state]}</span><span className="text-[var(--text-secondary)]">{inProgress(photo.state) ? '结果待更新' : `${photo.items.length} 类物品`}</span></div>
              <p className="mt-2 truncate text-sm font-medium">{photo.bin_name}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{displayCaptureDate(photo.captured_at)}</p>
              {photo.items.length ? <ul className="mt-3 divide-y divide-[var(--border-flat)]">{photo.items.map((item) => <li key={item.observation_id}><button type="button" aria-label={`查看${item.name}详情`} disabled={isDeleting} onClick={() => onSelectItem({ name: item.name, description: item.description, aliases: item.aliases, quantity: item.quantity, location: photo.bin_name, binId: photo.bin_id, seenAt: photo.captured_at, cropUrl: item.crop_url, previewUrl: photo.preview_url })} className="flex w-full items-center gap-2 py-2.5 text-left text-sm hover:text-[var(--accent)] disabled:opacity-50"><span className="min-w-0 flex-1 break-words">{item.name}</span><span className="shrink-0 text-xs text-[var(--text-secondary)]">{item.quantity === null ? '数量未知' : `× ${item.quantity}`}</span><ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" /></button></li>)}</ul>
                : <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">{inProgress(photo.state) ? '识别完成后，结果会自动显示在这里。' : photo.state === 'failed' || photo.state === 'expired' ? '这张照片没有产生识别结果，可以重新拍摄。' : '这张照片没有识别到物品。'}</p>}
            </div>
          </article>;
        })}</div>}
  </section>;
}
