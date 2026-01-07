import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Skeleton } from '../ui/skeleton';

interface MetricCardProps {
  title: string;
  value: string | number;
  description?: string;
  loading?: boolean;
  accent?: 'primary' | 'secondary';
}

export function MetricCard({
  title,
  value,
  description,
  loading,
  accent = 'primary'
}: MetricCardProps): JSX.Element {
  return (
    <Card className="overflow-hidden">
      {/* Accent bar */}
      <div
        className={`h-1 w-full ${
          accent === 'primary'
            ? 'bg-gradient-to-r from-brand-blue to-brand-orange'
            : 'bg-gradient-to-r from-amber-400 to-orange-500'
        }`}
      />

      <CardHeader className="pb-3">
        {/* ✅ FIXED: theme-aware text */}
        <CardTitle className="text-base font-semibold text-foreground">
          {title}
        </CardTitle>

        {description ? (
          <CardDescription className="text-muted-foreground">
            {description}
          </CardDescription>
        ) : null}
      </CardHeader>

      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-32" />
        ) : (
          /*  theme-aware value */
          <p className="text-3xl font-semibold text-foreground">
            {value}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
