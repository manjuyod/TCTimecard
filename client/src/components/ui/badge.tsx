import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary/10 text-primary',
        secondary: 'border-transparent bg-secondary/10 text-secondary',
        outline: 'border-border text-foreground',
        success: 'border-transparent bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
        warning: 'border-transparent bg-amber-50 text-amber-700 ring-1 ring-amber-100',
        danger: 'border-transparent bg-red-50 text-red-700 ring-1 ring-red-100',
        muted: 'border-transparent bg-slate-100 text-slate-700 ring-1 ring-slate-200'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
