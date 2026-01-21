import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { PublicOnlyRoute, ProtectedRoute, RoleRoute } from './components/auth/RouteGuards';
import { LoginPage } from './pages/auth/LoginPage';
import { SelectAccountPage } from './pages/auth/SelectAccountPage';
import { TimeoutPage } from './pages/auth/TimeoutPage';
import { TutorDashboardPage } from './pages/tutor/Dashboard';
import { TutorCalendarPage } from './pages/tutor/CalendarPage';
import { TutorTimeOffPage } from './pages/tutor/TimeOffPage';
import { AdminDashboardPage } from './pages/admin/Dashboard';
import { ApprovalsPage } from './pages/admin/ApprovalsPage';
import { PayPeriodSummaryPage } from './pages/admin/PayPeriodSummaryPage';
import { AppShell, NavItem } from './components/layout/AppShell';
import { WeeklyAttestationGate } from './components/tutor/WeeklyAttestationGate';
import { useAuth } from './providers/AuthProvider';

const tutorNav: NavItem[] = [
  { label: 'Dashboard', path: '/tutor/dashboard', icon: 'LayoutDashboard' },
  { label: 'Time Entry', path: '/tutor/calendar', icon: 'Calendar' },
  { label: 'Time Off', path: '/tutor/time-off', icon: 'Umbrella' }
];

const adminNav: NavItem[] = [
  { label: 'Dashboard', path: '/admin/dashboard', icon: 'LayoutDashboard' },
  { label: 'Approvals', path: '/admin/approvals', icon: 'Inbox' },
  { label: 'Pay Period Summary', path: '/admin/pay-period-summary', icon: 'Table2' }
];

function TutorLayout(): JSX.Element {
  const { session, logout } = useAuth();
  return (
    <AppShell navItems={tutorNav} role="TUTOR" userName={session?.displayName ?? null} onLogout={logout}>
      <WeeklyAttestationGate />
      <Outlet />
    </AppShell>
  );
}

function AdminLayout(): JSX.Element {
  const { session, logout } = useAuth();
  return (
    <AppShell navItems={adminNav} role="ADMIN" userName={session?.displayName ?? null} onLogout={logout}>
      <Outlet />
    </AppShell>
  );
}

function App(): JSX.Element {
  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/select-account" element={<SelectAccountPage />} />
      </Route>

      <Route path="/timeout" element={<TimeoutPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<RoleRoute role="TUTOR" />}>
          <Route element={<TutorLayout />}>
            <Route path="/tutor/dashboard" element={<TutorDashboardPage />} />
            <Route path="/tutor/calendar" element={<TutorCalendarPage />} />
            <Route path="/tutor/extra-hours" element={<Navigate to="/tutor/calendar" replace />} />
            <Route path="/tutor/time-off" element={<TutorTimeOffPage />} />
          </Route>
        </Route>

        <Route element={<RoleRoute role="ADMIN" />}>
          <Route element={<AdminLayout />}>
            <Route path="/admin/dashboard" element={<AdminDashboardPage />} />
            <Route path="/admin/approvals" element={<ApprovalsPage />} />
            <Route path="/admin/pay-period-summary" element={<PayPeriodSummaryPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default App;
