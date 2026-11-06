import { Camera, Check, MapPin, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { addBin, deleteBin, restoreBin, updateBin, useBinList } from '@/features/bins/useBins';
import { useAuth } from '@/lib/auth';
import type { Bin } from '@/types';

const inputClass = 'min-w-0 flex-1 rounded-lg border border-[var(--border-flat)] bg-[var(--bg-input)] px-3 py-3 text-base outline-none focus:ring-2 focus:ring-[var(--accent)]';

export function PlacesPage() {
  const { activeLocationId } = useAuth();
  const { bins, isLoading, refresh } = useBinList(undefined, 'name');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [deleting, setDeleting] = useState<Bin | null>(null);
  const [removed, setRemoved] = useState<Bin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!activeLocationId || !name.trim()) return;
    setBusy(true); setError('');
    try { await addBin({ name: name.trim(), locationId: activeLocationId }); setName(''); refresh(); }
    catch { setError('地点添加失败，请重试。'); }
    finally { setBusy(false); }
  }

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || !editName.trim()) return;
    setBusy(true); setError('');
    try { await updateBin(editing, { name: editName.trim() }); setEditing(null); refresh(); }
    catch { setError('地点改名失败，请重试。'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true); setError('');
    try { const place = await deleteBin(deleting.id); setRemoved(place); setDeleting(null); refresh(); }
    catch { setError('地点删除失败，请重试。'); }
    finally { setBusy(false); }
  }

  async function undo() {
    if (!removed) return;
    setBusy(true); setError('');
    try { await restoreBin(removed); setRemoved(null); refresh(); }
    catch { setError('地点恢复失败，请重试。'); }
    finally { setBusy(false); }
  }

  return <div className="mx-auto max-w-2xl">
    <header className="mb-7"><h1 className="text-3xl font-semibold tracking-tight">地点管理</h1><p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">给物品所在的地方取个名字，例如“书桌抽屉”。</p></header>
    <form onSubmit={create} className="flex gap-2"><input aria-label="新地点名称" value={name} onChange={(event) => setName(event.target.value)} placeholder="添加地点" maxLength={100} className={inputClass} required /><Button type="submit" disabled={busy || !name.trim() || !activeLocationId}><Plus className="mr-1 h-4 w-4" />添加</Button></form>
    {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
    {removed && <output className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-[var(--bg-active)] px-3 py-3 text-sm"><span>已删除“{removed.name}”</span><button type="button" disabled={busy} onClick={() => void undo()} className="inline-flex shrink-0 items-center gap-1 font-medium text-[var(--accent)]"><Undo2 className="h-4 w-4" />撤销</button></output>}
    {isLoading ? <p className="py-12 text-center text-sm text-[var(--text-secondary)]">正在加载地点…</p>
      : bins.length === 0 ? <div className="py-16 text-center"><MapPin className="mx-auto mb-4 h-8 w-8 text-[var(--text-tertiary)]" /><p className="text-sm text-[var(--text-secondary)]">添加第一个地点，然后去扫描物品。</p></div>
        : <ul className="mt-6 divide-y divide-[var(--border-flat)]">{bins.map((bin) => <li key={bin.id} className="py-5">
          {editing === bin.id ? <form onSubmit={rename} className="flex items-center gap-2"><input aria-label="地点名称" value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={100} className={inputClass} required /><button aria-label="保存地点名称" type="submit" disabled={busy || !editName.trim()} className="rounded-lg p-3 text-[var(--accent)] hover:bg-[var(--bg-active)]"><Check className="h-5 w-5" /></button><button aria-label="取消改名" type="button" disabled={busy} onClick={() => setEditing(null)} className="rounded-lg p-3 text-[var(--text-secondary)] hover:bg-[var(--bg-active)]"><X className="h-5 w-5" /></button></form>
            : <div className="flex items-center gap-3"><MapPin className="h-5 w-5 shrink-0 text-[var(--text-tertiary)]" /><div className="min-w-0 flex-1"><p className="break-words font-medium">{bin.name}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{bin.items?.length ?? 0} 类物品</p></div><button type="button" aria-label={`重命名${bin.name}`} disabled={busy} onClick={() => { setEditing(bin.id); setEditName(bin.name); }} className="rounded-lg p-2.5 text-[var(--text-secondary)] hover:bg-[var(--bg-active)]"><Pencil className="h-4 w-4" /></button><button type="button" aria-label={`删除地点${bin.name}`} disabled={busy} onClick={() => setDeleting(bin)} className="rounded-lg p-2.5 text-[var(--text-secondary)] hover:bg-red-500/10 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></div>}
          <div className="mt-3 flex gap-5 pl-8 text-sm"><Link to={`/scan?place=${encodeURIComponent(bin.id)}`} className="inline-flex items-center gap-1 text-[var(--accent)]"><Camera className="h-3.5 w-3.5" />扫描这里</Link><Link to={`/find?place=${encodeURIComponent(bin.id)}`} className="text-[var(--text-secondary)]">查看物品</Link></div>
        </li>)}</ul>}
    <Dialog open={!!deleting} onOpenChange={(open) => { if (!open && !busy) setDeleting(null); }}><DialogContent centered><DialogHeader><DialogTitle>删除“{deleting?.name}”？</DialogTitle><DialogDescription>这个地点和其中的物品、识别历史将从列表中移除。删除后可以在本页撤销。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '删除地点'}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
