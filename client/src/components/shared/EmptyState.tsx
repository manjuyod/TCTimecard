interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border bg-muted/60 p-6">
      <div>
        <p className="text-base font-semibold text-slate-900">{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
