import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  Session,
  SelectionAccount,
  LoginResult,
  login as loginApi,
  selectAccount as selectAccountApi,
  fetchSession,
  logout as logoutApi
} from '../lib/api';
import { ApiError } from '../lib/errors';

type SelectionState = {
  selectionToken: string;
  accounts: SelectionAccount[];
} | null;

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  selection: SelectionState;
  login: (identifier: string, password: string) => Promise<LoginResult>;
  selectAccount: (token: string, account: SelectionAccount) => Promise<Session>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  clearSelection: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const SELECTION_STORAGE_KEY = 'timecard:selection';

const persistSelection = (selection: SelectionState): void => {
  if (!selection) {
    sessionStorage.removeItem(SELECTION_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection));
};

const loadSelection = (): SelectionState => {
  try {
    const raw = sessionStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SelectionState;
    if (!parsed?.selectionToken || !parsed?.accounts?.length) return null;
    return parsed;
  } catch {
    return null;
  }
};

export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<SelectionState>(() => loadSelection());

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const existing = await fetchSession();
        setSession(existing);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setSession(null);
        } else {
          console.error('[auth] failed to load session', err);
        }
      } finally {
        setLoading(false);
      }
    };
    void bootstrap();
  }, []);

  useEffect(() => {
    persistSelection(selection);
  }, [selection]);

  const login = async (identifier: string, password: string): Promise<LoginResult> => {
    const result = await loginApi(identifier, password);
    if (result.session) {
      setSession(result.session);
      setSelection(null);
    } else if (result.requiresSelection && result.selectionToken && result.accounts?.length) {
      setSelection({
        selectionToken: result.selectionToken,
        accounts: result.accounts
      });
    }
    return result;
  };

  const selectAccount = async (token: string, account: SelectionAccount) => {
    const newSession = await selectAccountApi(token, account);
    setSession(newSession);
    setSelection(null);
    return newSession;
  };

  const logout = async () => {
    try {
      await logoutApi();
    } finally {
      setSession(null);
      setSelection(null);
      setLoading(false);
    }
  };

  const refresh = async () => {
    setLoading(true);
    const current = await fetchSession();
    setSession(current);
    setLoading(false);
  };

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      selection,
      login,
      selectAccount,
      logout,
      refresh,
      clearSelection: () => setSelection(null)
    }),
    [session, loading, selection]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};
