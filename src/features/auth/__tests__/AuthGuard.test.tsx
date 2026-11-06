import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth';
import { AuthGuard } from '../AuthGuard';

const status = vi.hoisted(() => ({ localMode: false }));
vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/qrConfig', () => ({
  isSelfHostedInstance: () => true,
  useAuthStatusConfig: () => ({
    config: {
      localMode: status.localMode,
      registrationMode: 'open',
      registrationEnabled: true,
      oauthProviders: [],
      demoMode: false,
      tosVersion: null,
      privacyVersion: null,
      marketingOptInVisible: false,
    },
    loaded: true,
  }),
}));

const mockedUseAuth = vi.mocked(useAuth);

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <Routes>
        <Route
          path="/protected"
          element={
            <AuthGuard>
              <div data-testid="child-content">Protected content</div>
            </AuthGuard>
          }
        />
        <Route path="/login" element={<div data-testid="login-page">Login</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status.localMode = false;
  });

  it('renders spinner while loading', () => {
    mockedUseAuth.mockReturnValue({ user: null, loading: true } as ReturnType<typeof useAuth>);
    renderWithRouter();
    expect(document.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByTestId('child-content')).toBeNull();
  });

  it('navigates to /login when unauthenticated', () => {
    mockedUseAuth.mockReturnValue({ user: null, loading: false } as ReturnType<typeof useAuth>);
    renderWithRouter();
    expect(screen.queryByTestId('child-content')).toBeNull();
    expect(screen.getByTestId('login-page')).toBeTruthy();
  });

  it('renders children when authenticated', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: '1', email: 'test@example.com' },
      loading: false,
    } as ReturnType<typeof useAuth>);
    renderWithRouter();
    expect(screen.getByTestId('child-content')).toBeTruthy();
  });

  it('does not show spinner when authenticated', () => {
    mockedUseAuth.mockReturnValue({
      user: { id: '1', email: 'test@example.com' },
      loading: false,
    } as ReturnType<typeof useAuth>);
    renderWithRouter();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('offers a connection retry instead of login when local startup fails', () => {
    status.localMode = true;
    mockedUseAuth.mockReturnValue({ user: null, loading: false } as ReturnType<typeof useAuth>);
    renderWithRouter();
    expect(screen.getByRole('button', { name: '重新连接' })).toBeTruthy();
    expect(screen.queryByTestId('login-page')).toBeNull();
    expect(screen.queryByTestId('child-content')).toBeNull();
  });

  it('opens the workspace for the automatically supplied local identity', () => {
    status.localMode = true;
    mockedUseAuth.mockReturnValue({ user: { id: 'local-user' }, loading: false } as ReturnType<typeof useAuth>);
    renderWithRouter();
    expect(screen.getByTestId('child-content')).toBeTruthy();
    expect(screen.queryByTestId('login-page')).toBeNull();
  });
});
