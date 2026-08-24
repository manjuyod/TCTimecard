import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migrationPath = path.resolve(process.cwd(), 'server/db/migrations/0012_pto_routes.sql');

test('route migration adds hashed center links and never stores a raw bearer token', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.time_off_center_links/i);
  assert.match(sql, /token_hash/i);
  assert.doesNotMatch(sql, /raw_token|plaintext_token/i);
  assert.doesNotMatch(sql, /expires_at/i);
  assert.match(sql, /UNIQUE\s*\(token_hash\)/i);
});

test('route migration rejects new PTO inserts while a center is disabled with a stable code', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /PTO_CENTER_DISABLED/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_reject_disabled_request/i);
  assert.match(sql, /BEFORE INSERT ON public\.time_off_requests/i);
  assert.match(sql, /RAISE EXCEPTION/i);
});

test('route migration deactivation preserves activation and sync timestamps and audits atomically', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_deactivate_center/i);
  assert.match(sql, /SET enabled = FALSE/i);
  assert.match(sql, /pto_audit_events/i);
  assert.doesNotMatch(sql, /first_activated_at\s*=\s*NULL/i);
  assert.doesNotMatch(sql, /last_successful_sync_at\s*=\s*NULL/i);
});
