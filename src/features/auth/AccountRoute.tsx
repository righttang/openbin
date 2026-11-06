import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStatusConfig } from '@/lib/qrConfig';

/** Account screens have no role in the shared local workspace. */
export function AccountRoute({ children, redirectTo = '/' }: { children: ReactNode; redirectTo?: string }) {
  const { config, loaded } = useAuthStatusConfig();

  if (!loaded) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[var(--bg-base)]">
        <div className="h-8 w-8 rounded-full border-2 border-[var(--bg-active)] border-t-[var(--accent)] animate-spin" />
      </div>
    );
  }

  return config.localMode ? <Navigate to={redirectTo} replace /> : children;
}
