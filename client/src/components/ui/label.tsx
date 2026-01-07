import * as React from 'react';
import { cn } from '../../lib/utils';

const Label = React.forwardRef<
  React.ElementRef<'label'>,
  React.ComponentPropsWithoutRef<'label'> & { requiredMark?: boolean }
>(({ className, children, requiredMark, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className
    )}
    {...props}
  >
    {children}
    {requiredMark ? <span className="ml-0.5 text-destructive">*</span> : null}
  </label>
));

Label.displayName = 'Label';

export { Label };
