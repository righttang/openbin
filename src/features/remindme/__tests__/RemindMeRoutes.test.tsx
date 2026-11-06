import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RemindMeRoutes } from '@/App';

vi.mock('@/lib/qrConfig', () => ({ initQrConfig: vi.fn() }));
vi.mock('@/lib/theme', () => ({ useTheme: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'local' }, loading: false, activeLocationId: 'home', setActiveLocationId: vi.fn() }), AuthProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/features/locations/useLocations', () => ({ LocationProvider: ({ children }: { children: React.ReactNode }) => children, useLocationList: () => ({ locations: [{ id: 'home' }], isLoading: false }) }));
vi.mock('../RemindMePage', () => ({ RemindMePage: () => <h1>扫描页面</h1> }));
vi.mock('../FindPage', () => ({ FindPage: () => <h1>查找页面</h1> }));
vi.mock('../PlacesPage', () => ({ PlacesPage: () => <h1>地点页面</h1> }));
vi.mock('../HistoryPage', () => ({ HistoryPage: () => <h1>历史页面</h1> }));

describe('four page navigation', () => {
  it('offers only scan, search, places and history without the former sidebar', async () => {
    render(<MemoryRouter initialEntries={['/']}><RemindMeRoutes /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: '扫描页面' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['扫描', '查找', '地点管理', '历史管理']);
    expect(screen.queryByText('OpenBin')).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Shopping List')).not.toBeInTheDocument();
  });

  it.each([['/bins', '地点页面'], ['/locations', '地点页面'], ['/bin/old-bin', '查找页面'], ['/items', '查找页面'], ['/settings/account', '扫描页面']])('routes legacy %s into the simple app', async (path, title) => {
    render(<MemoryRouter initialEntries={[path]}><RemindMeRoutes /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });
});
