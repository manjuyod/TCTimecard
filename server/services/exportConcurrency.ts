import type { Response } from 'express';

export const MAX_CONCURRENT_EXPORTS = 3;
export const EXPORT_RETRY_AFTER_SECONDS = 15;

export interface ExportConcurrencyGuard {
  readonly activeCount: number;
  tryAcquire(): (() => void) | null;
}

export const createExportConcurrencyGuard = (
  maxConcurrent = MAX_CONCURRENT_EXPORTS
): ExportConcurrencyGuard => {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive integer');
  }

  let activeCount = 0;
  return {
    get activeCount() {
      return activeCount;
    },
    tryAcquire() {
      if (activeCount >= maxConcurrent) return null;
      activeCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeCount -= 1;
      };
    }
  };
};

export const exportConcurrencyGuard = createExportConcurrencyGuard();

export const rejectBusyExport = (
  res: Response,
  log: (message: string) => void = console.warn
): void => {
  log('[export] concurrency limit reached');
  res.setHeader('Retry-After', EXPORT_RETRY_AFTER_SECONDS);
  res.status(429).json({ error: 'Exports are busy. Please retry shortly.' });
};
