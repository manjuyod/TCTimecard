interface LoadingScreenProps {
  label?: string;
}

export function LoadingScreen({ label = 'Loading...' }: LoadingScreenProps): JSX.Element {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="glass-panel flex items-center gap-3 px-4 py-3 shadow-md">
        <div className="relative h-3 w-3">
          <span className="absolute inset-0 rounded-full bg-primary/70 opacity-60 blur-[2px]" />
          <span className="absolute inset-0 animate-ping rounded-full bg-primary/70" />
          <span className="absolute inset-0 rounded-full bg-primary" />
        </div>
        <p className="text-sm font-semibold text-slate-800">{label}</p>
      </div>
    </div>
  );
}
