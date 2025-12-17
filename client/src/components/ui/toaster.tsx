import { Toaster } from 'sonner';

export function AppToaster(): JSX.Element {
  return (
    <Toaster
      position="top-right"
      expand
      richColors
      closeButton
      toastOptions={{
        className: 'shadow-lg border border-border rounded-xl bg-white',
        style: { fontSize: '0.95rem' }
      }}
    />
  );
}
