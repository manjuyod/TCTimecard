import { useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Calendar,
  ChevronLeft,
  Clock,
  Inbox,
  LayoutDashboard,
  Menu,
  Moon,
  Sun,
  Table2,
  Umbrella,
  LogOut
} from 'lucide-react';
import Logo from '../Logo';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import { useTheme } from '../../theme/useTheme';

export type AppRole = 'TUTOR' | 'ADMIN';

export type NavItem = {
  label: string;
  path: string;
  icon: keyof typeof iconMap;
};

const iconMap = {
  LayoutDashboard,
  Calendar,
  Clock,
  Umbrella,
  Inbox,
  Table2
};

interface AppShellProps {
  navItems: NavItem[];
  role: AppRole;
  userName?: string | null;
  onLogout?: () => Promise<void> | void;
  children: React.ReactNode;
}

const roleLabel: Record<AppRole, string> = {
  TUTOR: 'Tutor',
  ADMIN: 'Admin'
};

export function AppShell({ navItems, role, userName, onLogout, children }: AppShellProps): JSX.Element {
  const location = useLocation();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const { theme, toggleTheme } = useTheme();

  const activePath = location.pathname;
  const resolvedItems = useMemo(() => navItems ?? [], [navItems]);

  const handleLogout = async () => {
    if (!onLogout) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  const renderNavItems = () =>
    resolvedItems.map((item) => {
      const Icon = iconMap[item.icon] ?? LayoutDashboard;
      const isActive = activePath === item.path || (item.path !== '/' && activePath.startsWith(item.path));

      return (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive: navActive }) =>
            cn(
              'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
              navActive || isActive
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )
          }
          onClick={() => setMobileOpen(false)}
        >
          <span
            className={cn(
              'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card shadow-sm',
              isCollapsed ? 'mx-auto' : ''
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          {!isCollapsed && <span className="truncate">{item.label}</span>}
        </NavLink>
      );
    });

  return (
    <div className="relative flex min-h-screen">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden h-full bg-card/90 shadow-lg ring-1 ring-border backdrop-blur-sm transition-all duration-200 md:flex',
          isCollapsed ? 'w-20' : 'w-64'
        )}
      >
        <div className="flex w-full flex-col gap-6 px-4 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className={cn('flex items-center gap-2', isCollapsed && 'justify-center')}>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-brand-blue/20 to-brand-orange/10 ring-1 ring-border">
                <Logo className="h-9 w-auto" />
              </div>
              {!isCollapsed && (
                <div>
                  <p className="text-sm font-semibold text-foreground leading-4">Tutoring Club</p>
                  <p className="text-xs text-muted-foreground leading-4">Time Tracking</p>
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex"
              onClick={() => setIsCollapsed((prev) => !prev)}
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <ChevronLeft className={cn('h-4 w-4 transition-transform', isCollapsed && 'rotate-180')} />
            </Button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto">{renderNavItems()}</div>

          <div className={cn('rounded-lg bg-muted/70 p-3', isCollapsed && 'text-center')}>
            <p className="text-xs font-semibold text-muted-foreground">Signed in</p>
            {!isCollapsed && (
              <>
                <p className="text-sm font-semibold text-foreground">{userName || 'User'}</p>
                <Badge variant="secondary" className="mt-1">
                  {roleLabel[role]}
                </Badge>
              </>
            )}
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm md:hidden" onClick={() => setMobileOpen(false)} />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full w-72 flex-col gap-4 bg-card/95 p-4 shadow-xl ring-1 ring-border transition-transform duration-200 md:hidden',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Logo className="h-9 w-auto" />
            <div>
              <p className="text-sm font-semibold text-foreground leading-4">Tutoring Club</p>
              <p className="text-xs text-muted-foreground leading-4">Time Tracking</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-2">{renderNavItems()}</div>
      </aside>

      <div className="flex min-h-screen flex-1 flex-col md:pl-20 lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-card/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/70 md:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen((prev) => !prev)}
              aria-label="Toggle navigation"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2 rounded-full bg-muted/70 px-3 py-1">
              <Badge variant="secondary">{roleLabel[role]}</Badge>
              <span className="text-sm font-semibold text-foreground">{userName || 'User'}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              <span className="sr-only">Toggle theme</span>
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              <LogOut className="h-4 w-4" />
              <span className="sr-only">Logout</span>
            </Button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 md:px-6">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
