import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const parseDateForDisplay = (iso: string): { date: Date; forceUtc: boolean } | null => {
  if (DATE_ONLY_REGEX.test(iso)) {
    const [yearStr, monthStr, dayStr] = iso.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }

    const utcDate = new Date(Date.UTC(year, month - 1, day));
    return { date: utcDate, forceUtc: true };
  }

  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return null;
  return { date: dt, forceUtc: false };
};

export const formatDateRange = (startIso: string | null | undefined, endIso: string | null | undefined): string => {
  if (!startIso || !endIso) return '';
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';

  const sameDay = start.toDateString() === end.toDateString();
  const dateFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const timeFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

  if (sameDay) {
    return `${dateFormatter.format(start)} · ${timeFormatter.format(start)} - ${timeFormatter.format(end)}`;
  }

  return `${dateFormatter.format(start)} ${timeFormatter.format(start)} - ${dateFormatter.format(end)} ${timeFormatter.format(end)}`;
};

export const formatDateOnly = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const parsed = parseDateForDisplay(iso);
  if (!parsed) return '';

  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  };

  if (parsed.forceUtc) {
    options.timeZone = 'UTC';
  }

  return new Intl.DateTimeFormat('en-US', options).format(parsed.date);
};

export const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(dt);
};

export const hoursBetween = (startIso: string | null | undefined, endIso: string | null | undefined): number => {
  if (!startIso || !endIso) return 0;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const diffMs = end.getTime() - start.getTime();
  return Math.max(0, Math.round((diffMs / 1000 / 60 / 60) * 100) / 100);
};
