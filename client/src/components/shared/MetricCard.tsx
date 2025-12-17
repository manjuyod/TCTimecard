import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';

interface MetricCardProps {
  title: string;
  value: string | number;
  description?: string;
  loading?: boolean;
  accent?: 'primary' | 'secondary';
}

export function MetricCard({ title, value, description, loading, accent = 'primary' }: MetricCardProps): JSX.Element {
  return (
    <Card className="overflow-hidden">
      <div
        className={`h-1 w-full ${accent === 'primary' ? 'bg-gradient-to-r from-brand-blue to-brand-orange' : 'bg-gradient-to-r from-amber-400 to-orange-500'}`}
      />
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold text-slate-800">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-32" />
        ) : (
          <p className="text-3xl font-semibold text-slate-900">{value}</p>
        )}
      </CardContent>
    </Card>
  );
}
