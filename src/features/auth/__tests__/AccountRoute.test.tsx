import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRoute } from '../AccountRoute';

const status = vi.hoisted(() => ({ localMode: true, loaded: true }));
vi.mock('@/lib/qrConfig', () => ({
  useAuthStatusConfig: () => ({ config: { localMode: status.localMode }, loaded: status.loaded }),
}));

function renderRoute(path = '/login', redirectTo?: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>RemindMe workspace</div>} />
        <Route path="/settings/preferences" element={<div>Preferences</div>} />
        <Route path={path} element={<AccountRoute redirectTo={redirectTo}><div>Account screen</div></AccountRoute>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AccountRoute', () => {
  beforeEach(() => { status.localMode = true; status.loaded = true; });

  it.each(['/login', '/register', '/forgot-password', '/reset-password', '/auth/complete-signup', '/admin/users'])
    ('opens the workspace instead of %s in local mode', (path) => {
      renderRoute(path);
      expect(screen.getByText('RemindMe workspace')).toBeTruthy();
      expect(screen.queryByText('Account screen')).toBeNull();
    });

  it('redirects account settings to preferences without mounting account controls', () => {
    renderRoute('/settings/account', '/settings/preferences');
    expect(screen.getByText('Preferences')).toBeTruthy();
    expect(screen.queryByText('Account screen')).toBeNull();
  });

  it('does not flash account controls while configuration loads', () => {
    status.loaded = false;
    renderRoute();
    expect(screen.queryByText('Account screen')).toBeNull();
    expect(screen.queryByText('RemindMe workspace')).toBeNull();
  });

  it('keeps account screens available when local mode is disabled', () => {
    status.localMode = false;
    renderRoute();
    expect(screen.getByText('Account screen')).toBeTruthy();
  });
});
