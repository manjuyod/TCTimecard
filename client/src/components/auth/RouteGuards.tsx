import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../providers/AuthProvider';
import { AccountType } from '../../lib/api';
import { LoadingScreen } from '../common/LoadingScreen';

const defaultHome = (role: AccountType): string => (role === 'ADMIN' ? '/admin/dashboard' : '/tutor/dashboard');

export function ProtectedRoute(): JSX.Element {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingScreen label="Checking your session..." />;
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}

export function RoleRoute({ role }: { role: AccountType }): JSX.Element {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingScreen label="Loading your workspace..." />;
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (session.accountType !== role) {
    return <Navigate to={defaultHome(session.accountType)} replace state={{ from: location }} />;
  }

  return <Outlet />;
}

export function PublicOnlyRoute(): JSX.Element {
  const { session, loading } = useAuth();

  if (loading) {
    return <LoadingScreen label="Preparing sign-in..." />;
  }

  if (session) {
    return <Navigate to={defaultHome(session.accountType)} replace />;
  }

  return <Outlet />;
}
