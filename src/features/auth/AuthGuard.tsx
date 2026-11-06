import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { isSelfHostedInstance, useAuthStatusConfig } from '@/lib/qrConfig';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { config: authStatus, loaded: statusLoaded } = useAuthStatusConfig();
  const location = useLocation();

  if (loading || !statusLoaded) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[var(--bg-base)]">
        <div className="h-8 w-8 rounded-full border-2 border-[var(--bg-active)] border-t-[var(--accent)] animate-spin" />
      </div>
    );
  }

  if (!user) {
    if (authStatus.localMode) {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center gap-4 bg-[var(--bg-base)] px-6 text-center">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">暂时无法打开 RemindMe</h1>
          <p className="text-[var(--text-secondary)]">请确认 Mac 上的服务仍在运行，然后重试。</p>
          <Button onClick={() => window.location.reload()}>重新连接</Button>
        </div>
      );
    }
    return <Navigate to="/login" replace />;
  }

  // Cloud-only: redirect users with stale or missing consent to the
  // completion interstitial (covers OAuth signups, re-acceptance, and any
  // unconsented edge cases). Skip the redirect if we're already on it.
  const consentStale =
    !isSelfHostedInstance() &&
    authStatus.tosVersion !== null &&
    (user.currentTosVersion !== authStatus.tosVersion ||
      user.currentPrivacyVersion !== authStatus.privacyVersion);

  if (consentStale && location.pathname !== '/auth/complete-signup') {
    return <Navigate to="/auth/complete-signup" replace />;
  }

  return <>{children}</>;
}
