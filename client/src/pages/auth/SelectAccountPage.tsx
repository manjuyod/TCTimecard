import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { useAuth } from '../../providers/AuthProvider';
import { SelectionAccount } from '../../lib/api';
import { toast } from '../../components/ui/toast';
import { InlineError } from '../../components/shared/InlineError';

export function SelectAccountPage(): JSX.Element {
  const { selection, selectAccount, clearSelection } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<number | null>(null);

  const accounts = useMemo<SelectionAccount[]>(() => selection?.accounts ?? [], [selection]);

  if (!selection) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4">
        <Card className="w-full max-w-xl p-6 text-center">
          <CardTitle className="text-lg">No account selection found</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">
            Start a new login to choose an account. Your previous selection token may have expired.
          </p>
          <div className="mt-4 flex justify-center">
            <Button onClick={() => navigate('/login')}>Back to Login</Button>
          </div>
        </Card>
      </div>
    );
  }

  const handleSelect = async (account: SelectionAccount) => {
    setError(null);
    setSubmittingId(account.accountId);
    try {
      const session = await selectAccount(selection.selectionToken, account);
      toast.success(`Signed in as ${session.displayName || account.label}`);
      const home = session.accountType === 'ADMIN' ? '/admin/dashboard' : '/tutor/dashboard';
      navigate(home, { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to finish sign-in';
      setError(message);
      toast.error(message);
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">Select an account</h1>
        <p className="text-sm text-muted-foreground">
          Choose which role to continue as. You can always log out and switch later.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {accounts.map((account) => (
          <Card key={`${account.accountType}-${account.accountId}`} className="border-border/80">
            <CardHeader className="flex-row items-start justify-between gap-2">
              <div>
                <CardTitle className="text-lg">{account.label}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Franchise {account.franchiseId ?? 'N/A'} • ID #{account.accountId}
                </p>
              </div>
              <Badge variant="secondary">{account.accountType === 'ADMIN' ? 'Admin' : 'Tutor'}</Badge>
            </CardHeader>
            <CardContent className="flex justify-end">
              <Button
                onClick={() => void handleSelect(account)}
                disabled={submittingId === account.accountId}
                className="w-full md:w-auto"
              >
                {submittingId === account.accountId ? 'Signing in...' : 'Use this account'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={() => navigate('/login')}>
          Go back
        </Button>
        <Button variant="outline" onClick={() => clearSelection()}>
          Clear selection token
        </Button>
      </div>

      <InlineError message={error} />
    </div>
  );
}
