import { ChevronRight, MapPin, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBinList } from '@/features/bins/useBins';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Events, useRefreshOn } from '@/lib/eventBus';
import { displayCaptureDate, ItemDetail, type ItemDetailData } from './ItemDetail';
import type { InventoryItem } from './types';

export function FindPage() {
  const { activeLocationId } = useAuth();
  const { bins } = useBinList();
  const [params, setParams] = useSearchParams();
  const place = params.get('place') ?? '';
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<ItemDetailData | null>(null);
  const revision = useRefreshOn(Events.BINS);
  const searching = !!query.trim() || !!place;

  // biome-ignore lint/correctness/useExhaustiveDependencies: inventory mutations require fresh search results
  useEffect(() => {
    if (!activeLocationId || !searching) { setItems([]); setLoading(false); setError(''); return; }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const filters = new URLSearchParams({ location_id: activeLocationId, q: query.trim() });
      if (place) filters.set('bin_id', place);
      apiFetch<{ items: InventoryItem[] }>(`/api/captures/inventory?${filters}`, { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) { setItems(data.items); setError(''); } })
        .catch(() => { if (!controller.signal.aborted) setError('暂时无法查找，请稍后重试。'); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeLocationId, query, place, searching, revision]);

  return <div className="mx-auto max-w-2xl">
    <header className="mb-7"><h1 className="text-3xl font-semibold tracking-tight">查找</h1><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">想找什么？输入名称或描述。</p></header>
    <div className="relative"><Search className="absolute left-4 top-4 h-5 w-5 text-[var(--text-tertiary)]" /><input aria-label="搜索物品" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：剪刀、白色充电线" className="w-full rounded-xl border border-[var(--border-flat)] bg-[var(--bg-input)] py-3.5 pl-12 pr-4 text-base outline-none focus:ring-2 focus:ring-[var(--accent)]" /></div>
    <label className="mt-4 flex items-center gap-3 text-sm text-[var(--text-secondary)]">地点<select aria-label="查找地点" value={place} onChange={(event) => setParams(event.target.value ? { place: event.target.value } : {})} className="min-w-0 flex-1 rounded-lg border border-[var(--border-flat)] bg-[var(--bg-input)] px-3 py-2.5 text-sm text-[var(--text-primary)]"><option value="">所有地点</option>{bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.name}</option>)}</select></label>
    <div className="mt-7" aria-live="polite">
      {!searching ? <div className="py-14 text-center"><Search className="mx-auto mb-4 h-8 w-8 text-[var(--text-tertiary)]" /><p className="text-sm text-[var(--text-secondary)]">输入关键词，找到物品最后出现的地点。</p></div>
        : loading ? <p className="py-12 text-center text-sm text-[var(--text-secondary)]">正在查找…</p>
          : error ? <p role="alert" className="py-8 text-center text-sm text-red-600">{error}</p>
            : items.length === 0 ? <p className="py-12 text-center text-sm text-[var(--text-secondary)]">没有找到，试试其他名称或描述。</p>
              : <><p className="mb-2 text-xs text-[var(--text-tertiary)]">找到 {items.length} 类物品</p><ul className="divide-y divide-[var(--border-flat)]">{items.map((item) => <li key={item.id}>
                <button type="button" aria-label={`查看${item.name}详情`} onClick={() => setDetail({ name: item.name, description: item.description, aliases: item.aliases, quantity: item.quantity, location: item.bin_name, binId: item.bin_id, seenAt: item.last_seen_at, cropUrl: item.crop_url, previewUrl: item.photo_preview_url })} className="flex w-full items-center gap-3 py-5 text-left hover:text-[var(--accent)]">
                  {item.crop_url && <img src={item.crop_url} alt="" className="h-16 w-16 shrink-0 rounded-lg bg-[var(--bg-active)] object-contain" />}
                  <span className="min-w-0 flex-1"><span className="block font-medium">{item.name}</span><span className="mt-1.5 flex items-center gap-1 text-sm text-[var(--text-secondary)]"><MapPin className="h-3.5 w-3.5" />{item.bin_name}</span><span className="mt-1 block text-xs text-[var(--text-tertiary)]">{item.observation_state === 'not_seen_in_latest_capture' ? '最近未见 · ' : ''}{displayCaptureDate(item.last_seen_at)}</span></span>
                  <span className="text-xs text-[var(--text-secondary)]">{item.quantity === null ? '数量未知' : `× ${item.quantity}`}</span><ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                </button>
              </li>)}</ul></>}
    </div>
    <ItemDetail item={detail} onClose={() => setDetail(null)} />
  </div>;
}
