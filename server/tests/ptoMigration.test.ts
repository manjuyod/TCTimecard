import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migrationPath = path.resolve(__dirname, '../db/migrations/0010_shared_pto.sql');
const loadMigration = (): string =>
  existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').trim() : '';

test('shared PTO migration creates normalized policy, identity, cycle, ledger, and allocation tables', () => {
  const sql = loadMigration();
  const tables = [
    'pto_policies',
    'pto_center_settings',
    'pto_profiles',
    'pto_profile_crm_ids',
    'pto_profile_emails',
    'pto_profile_centers',
    'pto_entitlement_cycles',
    'pto_ledger_entries',
    'pto_request_allocations'
  ];

  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, 'i'));
  }
  assert.match(sql, /entitlement_days NUMERIC\(6, 2\) NOT NULL DEFAULT 5/i);
  assert.match(sql, /renewal_month SMALLINT NOT NULL DEFAULT 1/i);
  assert.match(sql, /renewal_day SMALLINT NOT NULL DEFAULT 1/i);
  assert.match(sql, /carryover_days NUMERIC\(6, 2\) NOT NULL DEFAULT 0/i);
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.doesNotMatch(sql, /\b(?:crm_ids|emails)\s+[A-Z ]*\[\]/i);
});

test('database charge and cycle functions encode the ordinary matrix and lock profiles before grants', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_charge_for_date\s*\(/i);
  assert.match(sql, /EXTRACT\(ISODOW FROM p_leave_date\)\s*=\s*6 THEN 0\.5/i);
  assert.match(sql, /EXTRACT\(ISODOW FROM p_leave_date\)\s*=\s*7 THEN 0/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_cycle_start\s*\(/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_get_or_create_cycle\s*\(/i);
  assert.match(sql, /FROM public\.pto_profiles[\s\S]*FOR UPDATE/i);
  assert.match(sql, /'grant:'\s*\|\|\s*v_cycle_id/i);
  assert.match(sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/i);
});

test('center activation is durable and policy changes are future-effective in the database', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_set_center_activation\s*\(/i);
  assert.match(sql, /NEW\.enabled AND NEW\.first_activated_at IS NULL/i);
  assert.match(sql, /NEW\.first_activated_at := CLOCK_TIMESTAMP\(\)/i);
  assert.match(sql, /first_activated_at cannot be changed/i);
  assert.match(sql, /CREATE TRIGGER pto_center_activation_guard/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_enforce_future_policy\s*\(/i);
  assert.match(sql, /NEW\.effective_from <= CURRENT_DATE/i);
  assert.match(sql, /PTO policy changes must be future-effective/i);
  assert.match(sql, /CREATE TRIGGER pto_policy_future_guard/i);
});

test('request-day expansion mirrors same-day and multi-date partial charge rules', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_request_day_charges\s*\(/i);
  assert.match(sql, /p_duration_hours <= 4 THEN 0\.5/i);
  assert.match(sql, /eligible_rank = 1 OR eligible_rank = eligible_count/i);
  assert.match(sql, /public\.pto_charge_for_date\(series_date::DATE\)/i);
  assert.match(sql, /ORDER BY ordinary\.leave_date/i);
});

test('profile resolution normalizes cross-center CRM IDs and emails without array identities', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_resolve_profile\s*\(/i);
  assert.match(sql, /LOWER\(BTRIM\(p_email\)\)/i);
  assert.match(sql, /provider = 'bridge'/i);
  assert.match(sql, /'timecard-center:'\s*\|\|\s*p_franchiseid/i);
  assert.match(sql, /INSERT INTO public\.pto_profile_centers/i);
  assert.match(sql, /PTO identities belong to different profiles/i);
  assert.match(sql, /PG_ADVISORY_XACT_LOCK/i);
});

test('pending reservation ignores pre-activation requests, splits cycles, and prevents overspend', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_reserve_request\s*\(/i);
  assert.match(sql, /NOT v_center\.enabled/i);
  assert.match(sql, /p_created_at < v_center\.first_activated_at/i);
  assert.match(sql, /public\.pto_get_or_create_cycle\(v_profile_id, v_day\.leave_date\)/i);
  assert.match(sql, /SUM\(balance_delta - reserved_delta\)/i);
  assert.match(sql, /Insufficient shared PTO balance/i);
  assert.match(sql, /'reserve:'\s*\|\|\s*p_request_id\s*\|\|\s*':'\s*\|\|\s*v_allocation\.cycle_id/i);
  assert.match(sql, /ON CONFLICT \(request_id, cycle_id\)/i);
});

test('request status transitions consume approvals and release denials or cancellations', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_transition_request\s*\(/i);
  assert.match(sql, /p_new_status = 'approved'[\s\S]*'consume'/i);
  assert.match(sql, /-v_allocation\.charged_days,\s*-v_allocation\.charged_days/i);
  assert.match(sql, /p_new_status IN \('denied', 'cancelled'\)[\s\S]*'release'/i);
  assert.match(sql, /WHEN v_allocation\.state = 'reserved' THEN -v_allocation\.charged_days/i);
  assert.match(sql, /WHEN v_allocation\.state = 'consumed' THEN v_allocation\.charged_days/i);
  assert.match(sql, /'consume:'\s*\|\|\s*p_request_id/i);
  assert.match(sql, /'release:'\s*\|\|\s*p_request_id/i);
});

test('time-off triggers reserve pending PTO, transition statuses, and protect held request fields', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_handle_time_off_request\s*\(/i);
  assert.match(sql, /TG_OP = 'INSERT' AND NEW\.status = 'pending'/i);
  assert.match(sql, /PERFORM public\.pto_reserve_request\s*\(/i);
  assert.match(sql, /NEW\.status IS DISTINCT FROM OLD\.status/i);
  assert.match(sql, /PERFORM public\.pto_transition_request\(NEW\.id, NEW\.status\)/i);
  assert.match(sql, /CREATE TRIGGER pto_time_off_request_lifecycle/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_protect_held_request\s*\(/i);
  for (const field of ['franchiseid', 'tutorid', 'bridge_profile_id', 'email', 'start_at', 'end_at', 'type', 'partial_day', 'duration_hours']) {
    assert.match(sql, new RegExp(`NEW\\.${field} IS DISTINCT FROM OLD\\.${field}`, 'i'));
  }
  assert.match(sql, /CREATE TRIGGER pto_time_off_request_held_fields/i);
});

test('PTO ledger entries are append-only', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.pto_reject_ledger_mutation\s*\(/i);
  assert.match(sql, /PTO ledger entries are append-only/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.pto_ledger_entries/i);
});

test('reviewed identity contract distinguishes confirmed, pending-name, and center-scoped public matches', () => {
  const sql = loadMigration();

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.pto_profile_match_candidates/i);
  assert.match(sql, /identity_status TEXT NOT NULL DEFAULT 'pending'/i);
  assert.match(sql, /UNIQUE \(profile_id, franchiseid, email\)/i);
  assert.match(sql, /p_request_source = 'public'/i);
  assert.match(sql, /email\.franchiseid = p_franchiseid/i);
  assert.match(sql, /v_public_match_count <> 1/i);
  assert.match(sql, /match_type TEXT NOT NULL DEFAULT 'exact_name'/i);
});

test('reviewed concurrency, policy, adjustment, and rerun guards remain explicit', () => {
  const sql = loadMigration();

  assert.match(sql, /FROM public\.time_off_requests WHERE id = p_request_id FOR UPDATE/i);
  assert.match(sql, /PTO policy effective date must begin on its renewal boundary/i);
  assert.match(sql, /PTO policy cannot reinterpret materialized PTO cycles/i);
  assert.match(sql, /CONSTRAINT pto_ledger_adjustment_contract CHECK/i);
  assert.match(sql, /MOD\(ABS\(balance_delta\), 0\.5\) = 0/i);
  assert.match(sql, /NULLIF\(BTRIM\(metadata ->> 'reason'\), ''\) IS NOT NULL/i);
  assert.match(sql, /SELECT DATE '1970-01-01' WHERE NOT EXISTS/i);
});
