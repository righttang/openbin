import { Camera, History, MapPin, Search } from 'lucide-react';
import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useLocationList } from '@/features/locations/useLocations';
import { useAuth } from '@/lib/auth';
import { useNavigationGuard } from '@/lib/navigationGuard';
import { useTheme } from '@/lib/theme';

const pages = [
  { path: '/scan', label: '扫描', icon: Camera, primary: true },
  { path: '/find', label: '查找', icon: Search, primary: true },
  { path: '/places', label: '地点管理', icon: MapPin, primary: false },
  { path: '/history', label: '历史管理', icon: History, primary: false },
];

function PageLinks({ mobile = false }: { mobile?: boolean }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { guardedNavigate } = useNavigationGuard();
  return <nav aria-label={mobile ? '底部导航' : '主导航'} className={mobile ? 'grid grid-cols-4' : 'flex items-center gap-1'}>
    {pages.map(({ path, label, icon: Icon, primary }) => <button key={path} type="button"
      aria-current={pathname === path ? 'page' : undefined}
      onClick={() => guardedNavigate(() => navigate(path))}
      className={`${mobile ? 'flex min-h-16 flex-col items-center justify-center gap-1 text-xs' : 'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm'} ${pathname === path ? 'bg-[var(--bg-active)] font-semibold text-[var(--accent)]' : primary ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'} transition-colors hover:bg-[var(--bg-active)]`}>
      <Icon className={mobile ? 'h-5 w-5' : 'h-4 w-4'} />{label}
    </button>)}
  </nav>;
}

/** One shared household stays internal; the product only exposes flat places. */
export function RemindMeLayout() {
  useTheme();
  const { activeLocationId, setActiveLocationId } = useAuth();
  const { locations, isLoading } = useLocationList();
  useEffect(() => {
    if (!isLoading && locations.length && !locations.some((location) => location.id === activeLocationId)) {
      setActiveLocationId(locations[0].id);
    }
  }, [activeLocationId, isLoading, locations, setActiveLocationId]);

  return <div className="min-h-dvh bg-[var(--bg-base)] text-[var(--text-primary)]">
    <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:bg-[var(--bg-elevated)] focus:p-3">跳到主要内容</a>
    <header className="sticky top-0 z-40 border-b border-[var(--border-flat)] bg-[var(--bg-base)]">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5 sm:px-8">
        <span className="text-lg font-semibold tracking-tight">RemindMe</span>
        <div className="hidden sm:block"><PageLinks /></div>
        <span className="text-xs text-[var(--text-tertiary)] sm:hidden">记住物品，轻松找到</span>
      </div>
    </header>
    <main id="main-content" className="mx-auto max-w-5xl px-5 pb-[calc(96px+var(--safe-bottom))] pt-7 sm:px-8 sm:pb-12 sm:pt-10">
      {isLoading && !activeLocationId ? <p className="py-12 text-center text-sm text-[var(--text-secondary)]">正在准备…</p> : <Outlet />}
    </main>
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-flat)] bg-[var(--bg-elevated)] pb-[var(--safe-bottom)] sm:hidden"><PageLinks mobile /></div>
  </div>;
}
