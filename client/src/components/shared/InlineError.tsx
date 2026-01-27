export function InlineError({ message }: { message?: string | null }): JSX.Element | null {
  if (!message) return null;

  return (
    <p className="mt-1 text-sm font-medium text-destructive">
      {message}
    </p>
  );
}
