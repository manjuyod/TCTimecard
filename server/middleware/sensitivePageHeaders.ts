import { Response } from 'express';

export function setSensitivePageHeaders(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
}
