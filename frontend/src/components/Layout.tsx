import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { History, LayoutGrid, LogOut, Moon, PackageOpen, Sun } from 'lucide-react';
import { session } from '../lib/api';

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('rms-theme', next ? 'dark' : 'light');
    } catch {
      /* storage unavailable */
    }
    setDark(next);
  };
  return { dark, toggle };
}

const NAV = [
  { to: '/', label: 'Inventory', icon: LayoutGrid, end: true },
  { to: '/history', label: 'Device History', icon: History, end: false },
];

export function Layout() {
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <div className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
              <PackageOpen className="h-4 w-4" />
            </span>
            <span className="hidden sm:inline">RMS Software Portal</span>
          </div>
          <nav className="flex items-center gap-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition',
                    isActive
                      ? 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white',
                  )
                }
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-sm text-slate-500 md:inline">{session.user}</span>
            <button onClick={toggle} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Toggle theme">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              onClick={() => {
                session.clear();
                navigate('/login');
              }}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
