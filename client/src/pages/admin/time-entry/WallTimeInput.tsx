import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { resolveWallTime } from '../../../lib/adminTimeEntry';

export type WallTimeDraft = { time: string; offset: string };
export function WallTimeInput({ id, label, date, timezone, value, onChange, describedBy, errorMessage }: {
  id: string; label: string; date: string; timezone: string; value: WallTimeDraft;
  onChange: (value: WallTimeDraft) => void; describedBy?: string; errorMessage?: string;
}): JSX.Element {
  const result = resolveWallTime(date, value.time, timezone);
  return <div className="space-y-1">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="time" step={60} value={value.time} className="min-h-11"
      aria-invalid={Boolean(errorMessage)} aria-describedby={errorMessage ? `${id}-error` : describedBy} onChange={event => onChange({ time: event.target.value, offset: '' })} />
    {errorMessage && <p id={`${id}-error`} className="text-sm text-destructive">{errorMessage}</p>}
    {result.options.length > 1 && <>
      <Label htmlFor={`${id}-offset`}>{label} offset</Label>
      <select id={`${id}-offset`} value={value.offset} aria-describedby={describedBy}
        className="min-h-11 w-full rounded-md border bg-background px-2 text-sm"
        onChange={event => onChange({ ...value, offset: event.target.value })}>
        <option value="">Choose which occurrence</option>
        {result.options.map(option => <option key={option.iso} value={option.offset}>{option.label}</option>)}
      </select>
    </>}
  </div>;
}
