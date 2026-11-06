import { AlertCircle, RefreshCw } from 'lucide-react';
import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ToastProvider, useToast } from '@/components/ui/toast';
import { LocationProvider } from '@/features/locations/useLocations';
import { RemindMeLayout } from '@/features/remindme/RemindMeLayout';
import { AuthProvider, useAuth } from '@/lib/auth';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import { NavigationGuardProvider } from '@/lib/navigationGuard';
import { initQrConfig } from '@/lib/qrConfig';

initQrConfig();

const ScanPage = lazyWithRetry(() => import('@/features/remindme/RemindMePage').then((module) => ({ default: module.RemindMePage })));
const FindPage = lazyWithRetry(() => import('@/features/remindme/FindPage').then((module) => ({ default: module.FindPage })));
const PlacesPage = lazyWithRetry(() => import('@/features/remindme/PlacesPage').then((module) => ({ default: module.PlacesPage })));
const HistoryPage = lazyWithRetry(() => import('@/features/remindme/HistoryPage').then((module) => ({ default: module.HistoryPage })));

function Loading() {
  return <p className="py-16 text-center text-sm text-[var(--text-secondary)]">正在加载…</p>;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[RemindMe]', error, info.componentStack);
  }
  render() {
    if (this.state.failed) return <ConnectionError />;
    return this.props.children;
  }
}

function ConnectionError() {
  return <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--bg-base)] px-6 text-center text-[var(--text-primary)]">
    <AlertCircle className="h-9 w-9 text-[var(--text-tertiary)]" /><h1 className="text-xl font-semibold">暂时无法打开 RemindMe</h1><p className="max-w-sm text-sm leading-6 text-[var(--text-secondary)]">请确认服务仍在运行，然后重新连接。</p><Button onClick={() => window.location.reload()}><RefreshCw className="mr-2 h-4 w-4" />重新连接</Button>
  </div>;
}

function Ready({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <ConnectionError />;
  return <>{children}</>;
}

let reloaded = false;
function UpdateNotifier() {
  const { showToast } = useToast();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    const changed = () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      showToast({ message: '新版本已准备好', duration: 10000, action: { label: '刷新', onClick: () => window.location.reload() } });
    };
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', changed);
  }, [showToast]);
  return null;
}

function LegacyPlaceRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/find?place=${encodeURIComponent(id)}` : '/places'} replace />;
}

export function RemindMeRoutes() {
  return <Routes>
    <Route element={<Ready><LocationProvider><RemindMeLayout /></LocationProvider></Ready>}>
      <Route path="/scan" element={<Suspense fallback={<Loading />}><ScanPage /></Suspense>} />
      <Route path="/find" element={<Suspense fallback={<Loading />}><FindPage /></Suspense>} />
      <Route path="/places" element={<Suspense fallback={<Loading />}><PlacesPage /></Suspense>} />
      <Route path="/history" element={<Suspense fallback={<Loading />}><HistoryPage /></Suspense>} />
      <Route path="/bin/:id" element={<LegacyPlaceRedirect />} />
      <Route path="/bins" element={<Navigate to="/places" replace />} />
      <Route path="/locations" element={<Navigate to="/places" replace />} />
      <Route path="/items" element={<Navigate to="/find" replace />} />
      <Route path="*" element={<Navigate to="/scan" replace />} />
    </Route>
  </Routes>;
}

export default function App() {
  return <ErrorBoundary><BrowserRouter><NavigationGuardProvider><ToastProvider><AuthProvider>
    <UpdateNotifier /><RemindMeRoutes />
  </AuthProvider></ToastProvider></NavigationGuardProvider></BrowserRouter></ErrorBoundary>;
}
