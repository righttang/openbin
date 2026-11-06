import { ImageOff, MapPin } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface ItemDetailData {
  name: string;
  description: string;
  aliases: string[];
  quantity: number | null;
  location: string;
  binId: string;
  seenAt: string | null;
  cropUrl?: string | null;
  previewUrl?: string | null;
}

export function displayCaptureDate(value: string | null): string {
  if (!value) return '尚无拍摄记录';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function DetailImage({ item }: { item: ItemDetailData }) {
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const crop = item.cropUrl && !failedUrls.includes(item.cropUrl) ? item.cropUrl : null;
  const preview = item.previewUrl && !failedUrls.includes(item.previewUrl) ? item.previewUrl : null;
  const url = crop || preview;
  if (!url) return <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl bg-[var(--bg-active)] p-5 text-center text-sm text-[var(--text-secondary)]">
    <ImageOff className="h-7 w-7" />
    <p>这条记录暂无图片</p>
    <p className="text-xs leading-5">旧照片已清理时无法补回图片；新拍摄会保留预览和可识别物品的裁剪图。</p>
  </div>;
  return <figure>
    <div className="overflow-hidden rounded-xl bg-[var(--bg-active)]">
      <img src={url} alt={crop ? `${item.name}的裁剪照片` : `${item.name}所在的原照片预览`}
        className="max-h-[42dvh] min-h-40 w-full object-contain"
        onError={() => setFailedUrls((urls) => [...urls, url])} />
    </div>
    <figcaption className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">{crop
      ? '从本次照片裁剪 · 边界由模型定位，可能包含周围物品'
      : '原照片预览 · 这件物品暂无裁剪图'}</figcaption>
  </figure>;
}

export function ItemDetail({ item, onClose }: { item: ItemDetailData | null; onClose: () => void }) {
  return <Dialog open={!!item} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-lg" fullScreenMobile>
      {item && <>
        <DialogHeader className="pr-7 text-left">
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>{item.quantity === null ? '数量未知' : `数量 ${item.quantity}`}</DialogDescription>
        </DialogHeader>
        <DetailImage key={`${item.cropUrl}:${item.previewUrl}:${item.name}`} item={item} />
        {item.description && <p className="mt-5 text-sm leading-7 text-[var(--text-primary)]">{item.description}</p>}
        {item.aliases.length > 0 && <ul className="mt-4 flex flex-wrap gap-2" aria-label="物品别名">
          {item.aliases.map((alias) => <li key={alias} className="rounded-full bg-[var(--bg-active)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">{alias}</li>)}
        </ul>}
        <div className="mt-5 border-t border-[var(--border-flat)] pt-4">
          <Link to={`/bin/${item.binId}`} onClick={onClose} className="inline-flex items-center gap-1.5 text-sm text-[var(--accent)]"><MapPin className="h-4 w-4" />{item.location}</Link>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">最后看到：{displayCaptureDate(item.seenAt)}</p>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
