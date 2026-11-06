import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarContent } from '../Sidebar';

const mocks = vi.hoisted(() => ({ localMode: true, logout: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ logout: mocks.logout }) }));
vi.mock('@/lib/qrConfig', () => ({
  useAuthStatusConfig: () => ({ config: { localMode: mocks.localMode }, loaded: true }),
}));
vi.mock('@/lib/appSettings', () => ({ useAppSettings: () => ({ settings: { appName: 'RemindMe' } }) }));
vi.mock('@/lib/navigationGuard', () => ({ useNavigationGuard: () => ({ guardedNavigate: (action: () => void) => action() }) }));
vi.mock('@/lib/terminology', () => ({ useTerminology: () => ({ Bins: 'Bins', Locations: 'Locations' }) }));
vi.mock('@/lib/usePermissions', () => ({ usePermissions: () => ({ canWrite: true }) }));
vi.mock('@/lib/usePlan', () => ({ usePlan: () => ({ isSelfHosted: true, isFree: false }) }));

function renderSidebar() {
  return render(
    <MemoryRouter>
      <SidebarContent locations={[]} activeLocationId={null} onLocationChange={() => {}} />
    </MemoryRouter>,
  );
}

describe('local workspace navigation', () => {
  beforeEach(() => { mocks.localMode = true; mocks.logout.mockReset(); });

  it('keeps settings and inventory navigation without a sign-out control', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bins' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign Out' })).toBeNull();
  });

  it('preserves sign-out behavior when account authentication is enabled', () => {
    mocks.localMode = false;
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    expect(mocks.logout).toHaveBeenCalledOnce();
  });
});
