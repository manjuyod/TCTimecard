import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Logo from '../../components/Logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Button } from '../../components/ui/button';
import { InlineError } from '../../components/shared/InlineError';
import { useAuth } from '../../providers/AuthProvider';
import { toast } from '../../components/ui/toast';

export function LoginPage(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, selection } = useAuth();
  const [form, setForm] = useState({ identifier: '', password: '' });
  const [errors, setErrors] = useState<{ identifier?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  const fromState = (location.state as { from?: Location })?.from;

  const validate = () => {
    const nextErrors: { identifier?: string; password?: string } = {};
    if (!form.identifier.trim()) nextErrors.identifier = 'Email or username is required.';
    if (!form.password.trim()) nextErrors.password = 'Password is required.';
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!validate()) return;
    setSubmitting(true);

    try {
      const result = await login(form.identifier.trim(), form.password);

      if (result.requiresSelection) {
        toast('Select which account to continue.');
        navigate('/select-account', { replace: true });
        return;
      }

      if (result.session) {
        const next =
          (fromState?.pathname &&
            ((result.session.accountType === 'ADMIN' && fromState.pathname.startsWith('/admin')) ||
              (result.session.accountType === 'TUTOR' && fromState.pathname.startsWith('/tutor'))))
            ? fromState.pathname
            : result.session.accountType === 'ADMIN'
              ? '/admin/dashboard'
              : '/tutor/dashboard';
        navigate(next, { replace: true });
        toast.success('Welcome back!');
        return;
      }

      toast('Logged in. Redirecting...');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to log in';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-4xl grid gap-6 md:grid-cols-[1.2fr_1fr]">
        <Card className="glass-panel shadow-xl">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-white p-1.5 shadow-inner ring-1 ring-border">
                <Logo className="h-full w-full" />
              </div>
              <div>
                <CardTitle className="text-xl">Tutoring Club Time Cards</CardTitle>
                <CardDescription>Sign in to manage hours, calendars, and approvals.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="identifier" requiredMark>
                  Email or Username
                </Label>
                <Input
                  id="identifier"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={form.identifier}
                  onChange={(e) => setForm((prev) => ({ ...prev, identifier: e.target.value }))}
                />
                <InlineError message={errors.identifier} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" requiredMark>
                  Password
                </Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={form.password}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                />
                <InlineError message={errors.password} />
              </div>

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? 'Signing in...' : 'Sign In'}
              </Button>
              {selection ? (
                <p className="text-sm text-muted-foreground">
                  Account selection in progress. <Link to="/select-account" className="text-primary underline">Continue here</Link>.
                </p>
              ) : null}
            </form>
          </CardContent>
        </Card>

        <div className="glass-panel hidden flex-col gap-4 p-6 shadow-xl md:flex">
          <p className="text-lg font-semibold text-slate-900">What you can do</p>
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li>• Tutors: log hours, request extra time, and manage time off.</li>
            <li>• Admins: review approvals and export pay period summaries.</li>
            <li>• Secure dual-role support with quick account selection.</li>
          </ul>
          <div className="rounded-lg bg-gradient-to-r from-brand-blue/10 via-white to-brand-orange/10 p-4 text-sm text-slate-800">
            Keep light theme on by default. Dark mode toggle is available as a placeholder in the app shell.
          </div>
          <div className="text-xs text-muted-foreground">
            Having trouble? Confirm your credentials with your supervisor or reset from the admin portal.
          </div>
        </div>
      </div>
    </div>
  );
}
