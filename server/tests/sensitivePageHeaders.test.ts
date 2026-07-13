import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setSensitivePageHeaders } from '../middleware/sensitivePageHeaders';

it('prevents decision pages from being cached or indexed', () => {
  const headers = new Map<string, string>();
  setSensitivePageHeaders({
    set(name: string, value: string) {
      headers.set(name, value);
      return this;
    }
  } as never);

  assert.equal(headers.get('Cache-Control'), 'no-store');
  assert.equal(headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
});
