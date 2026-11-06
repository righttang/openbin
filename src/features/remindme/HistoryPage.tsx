import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBinList } from '@/features/bins/useBins';
import { useAuth } from '@/lib/auth';
import { Events, notify } from '@/lib/eventBus';
import { ItemDetail, type ItemDetailData } from './ItemDetail';
import { PhotoHistory } from './PhotoHistory';

export function HistoryPage() {
  const { activeLocationId } = useAuth();
  const { bins } = useBinList();
  const [params, setParams] = useSearchParams();
  const place = params.get('place') ?? '';
  const [detail, setDetail] = useState<ItemDetailData | null>(null);
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => { notify(Events.BINS); }, []);
  const deleted = useCallback(() => { setDetail(null); setRevision((value) => value + 1); notify(Events.BINS); }, []);
  return <div>
    <header className="mb-7"><h1 className="text-3xl font-semibold tracking-tight">历史管理</h1><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">按照片查看识别结果，点击物品查看裁剪详情。</p></header>
    <label className="mb-6 flex max-w-lg items-center gap-3 text-sm text-[var(--text-secondary)]">地点<select aria-label="历史地点" value={place} onChange={(event) => setParams(event.target.value ? { place: event.target.value } : {})} className="min-w-0 flex-1 rounded-lg border border-[var(--border-flat)] bg-[var(--bg-input)] px-3 py-2.5 text-sm text-[var(--text-primary)]"><option value="">所有地点</option>{bins.map((bin) => <option key={bin.id} value={bin.id}>{bin.name}</option>)}</select></label>
    <PhotoHistory binId={place} locationId={activeLocationId} refreshKey={revision} onResultsChanged={changed} onDeleted={deleted} onSelectItem={setDetail} compactHeading />
    <ItemDetail item={detail} onClose={() => setDetail(null)} />
  </div>;
}
