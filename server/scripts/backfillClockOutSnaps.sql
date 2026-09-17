-- STAGING: prepared only; not executed against any database.
-- Run this entire file as one batch in the intended Neon staging database.
-- Scope: franchises (6,11,16,60,110,57,103), submitted work dates 2026-09-01..2026-09-15.
-- All closed sessions in scope qualify, including manual/admin edits and auto clock-outs.
-- Existing statuses, approvals, clock-ins, breaks, schedules, and audit history stay unchanged.
-- ROLLBACK at the bottom gives a trial run; replace it with COMMIT to keep the updates.

BEGIN;
SET LOCAL TIME ZONE 'UTC';

-- STEP 1: Round end_at to the nearest quarter-hour.
-- Minutes 0-7 of each quarter round down; minutes 8-14 round up. Seconds are removed.
CREATE TEMP TABLE _snap_changes ON COMMIT DROP AS
WITH proposed AS (
  SELECT s.id AS session_id, s.entry_day_id, d.franchiseid, d.tutorid, d.work_date,
    s.start_at, s.end_at AS previous_end_at,
    date_trunc('minute', s.end_at) +
      CASE WHEN extract(minute FROM s.end_at)::integer % 15 <= 7
        THEN -(extract(minute FROM s.end_at)::integer % 15)
        ELSE 15 - (extract(minute FROM s.end_at)::integer % 15)
      END * INTERVAL '1 minute' AS rounded_end_at
  FROM public.time_entry_sessions s
  JOIN public.time_entry_days d ON d.id = s.entry_day_id
    AND d.franchiseid = s.franchiseid AND d.tutorid = s.tutorid
  WHERE d.franchiseid IN (6, 11, 16, 60, 110, 57, 103)
    AND d.work_date BETWEEN DATE '2026-09-01' AND DATE '2026-09-15'
    AND (d.submitted_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.time_entry_audit a
      WHERE a.entry_day_id = d.id AND a.action IN ('submitted', 'auto_approved')
    ))
    AND s.end_at IS NOT NULL
)
SELECT * FROM proposed
WHERE rounded_end_at <> previous_end_at
  AND rounded_end_at > start_at; -- Keep the database's end-after-start constraint valid.

UPDATE public.time_entry_sessions s
SET end_at = c.rounded_end_at, updated_at = NOW()
FROM _snap_changes c
WHERE s.id = c.session_id;

-- STEP 2: Rebuild the affected days' stored comparison from the corrected sessions.
-- These temporary helpers reproduce the app's interval, break, and schedule calculations.
-- They require PostgreSQL 14+ and do not install public functions or permanent tables.
-- Only temporary helper functions are created; no public schema functions change.
CREATE OR REPLACE FUNCTION pg_temp.cos_timestamp(value text, minute_aligned boolean DEFAULT TRUE)
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $fn$
DECLARE parsed timestamptz;
BEGIN
  IF value IS NULL OR btrim(value) !~* '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' THEN
    RETURN NULL;
  END IF;
  parsed := value::timestamptz;
  IF NOT isfinite(parsed) OR (minute_aligned AND parsed <> date_trunc('minute', parsed)) THEN
    RETURN NULL;
  END IF;
  RETURN parsed;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END
$fn$;

-- Union of half-open intervals. A NULL result means invalid input; [] means no time.
CREATE OR REPLACE FUNCTION pg_temp.cos_ranges(items jsonb)
RETURNS tstzmultirange LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  item jsonb;
  start_at timestamptz;
  end_at timestamptz;
  result tstzmultirange := '{}'::tstzmultirange;
BEGIN
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
    start_at := pg_temp.cos_timestamp(item->>'startAt');
    end_at := pg_temp.cos_timestamp(item->>'endAt');
    IF start_at IS NULL OR end_at IS NULL OR end_at <= start_at THEN RETURN NULL; END IF;
    result := result + tstzmultirange(tstzrange(start_at, end_at, '[)'));
  END LOOP;
  RETURN result;
END
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.cos_minutes(items tstzmultirange)
RETURNS bigint LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (upper(r) - lower(r))) / 60), 0)::bigint
  FROM unnest(items) AS ranges(r)
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.cos_intervals(items tstzmultirange)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'startAt', to_char(lower(r) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endAt', to_char(upper(r) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY lower(r)), '[]'::jsonb)
  FROM unnest(items) AS ranges(r)
$fn$;

-- SQL translation of computeTimeEntryComparisonV2 / computeTimeAllocation.
-- Unpaid time takes precedence over overlapping paid breaks. Only completed breaks
-- affect totals. Duration-only breaks produce warnings without subtracting pay.
CREATE OR REPLACE FUNCTION pg_temp.cos_comparison(sessions jsonb, breaks jsonb, schedule jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  manual_union tstzmultirange := pg_temp.cos_ranges(sessions);
  scheduled_union tstzmultirange := pg_temp.cos_ranges(schedule);
  paid_breaks tstzmultirange := '{}'::tstzmultirange;
  unpaid_breaks tstzmultirange := '{}'::tstzmultirange;
  all_breaks tstzmultirange;
  in_session_breaks tstzmultirange;
  in_session_unpaid tstzmultirange;
  payable tstzmultirange;
  active_tutoring tstzmultirange;
  covered tstzmultirange;
  item jsonb;
  start_at timestamptz;
  end_at timestamptz;
  unpositioned bigint := 0;
  scheduled_minutes bigint;
  covered_minutes bigint;
  paid_minutes bigint;
  deficit bigint;
  extra_paid bigint;
BEGIN
  IF manual_union IS NULL OR scheduled_union IS NULL OR jsonb_typeof(breaks) IS DISTINCT FROM 'array' THEN
    RETURN NULL;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(breaks) LOOP
    IF item->>'status' IS DISTINCT FROM 'completed' THEN CONTINUE; END IF;
    start_at := pg_temp.cos_timestamp(item->>'start_time');
    end_at := pg_temp.cos_timestamp(item->>'end_time');
    IF start_at IS NULL OR end_at IS NULL OR end_at <= start_at THEN
      unpositioned := unpositioned + GREATEST(0, COALESCE((item->>'duration_minutes')::bigint, 0));
    ELSIF item->>'pay_treatment' = 'paid' THEN
      paid_breaks := paid_breaks + tstzmultirange(tstzrange(start_at, end_at, '[)'));
    ELSE
      unpaid_breaks := unpaid_breaks + tstzmultirange(tstzrange(start_at, end_at, '[)'));
    END IF;
  END LOOP;
  all_breaks := paid_breaks + unpaid_breaks;
  in_session_breaks := manual_union * all_breaks;
  in_session_unpaid := manual_union * unpaid_breaks;
  active_tutoring := manual_union - in_session_breaks;
  payable := manual_union - in_session_unpaid;
  covered := active_tutoring * scheduled_union;
  scheduled_minutes := pg_temp.cos_minutes(scheduled_union);
  covered_minutes := pg_temp.cos_minutes(covered);
  paid_minutes := pg_temp.cos_minutes(payable);
  deficit := GREATEST(0, scheduled_minutes - covered_minutes);
  extra_paid := GREATEST(0, paid_minutes - pg_temp.cos_minutes(payable * scheduled_union));

  RETURN jsonb_build_object(
    'version', 2,
    'computedAt', to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'matches', deficit = 0 AND extra_paid = 0,
    'exactMatch', manual_union = scheduled_union,
    'manual', jsonb_build_object(
      'union', pg_temp.cos_intervals(manual_union),
      'grossMinutes', pg_temp.cos_minutes(manual_union),
      'paidBreakMinutes', pg_temp.cos_minutes(manual_union * (paid_breaks - unpaid_breaks)),
      'unpaidBreakMinutes', pg_temp.cos_minutes(in_session_unpaid),
      'paidMinutes', paid_minutes, 'totalMinutes', paid_minutes
    ),
    'scheduled', jsonb_build_object(
      'union', pg_temp.cos_intervals(scheduled_union), 'totalMinutes', scheduled_minutes,
      'coveredMinutes', covered_minutes, 'deficitMinutes', deficit,
      'deltaMinutes', covered_minutes - scheduled_minutes
    ),
    'extra', jsonb_build_object('paidMinutes', extra_paid),
    'breaks', jsonb_build_object(
      'scheduledOverlapMinutes', pg_temp.cos_minutes(in_session_breaks * scheduled_union),
      'outsideScheduleMinutes', pg_temp.cos_minutes(in_session_breaks - scheduled_union),
      'outsideSessionMinutes', pg_temp.cos_minutes(all_breaks - manual_union),
      'unpositionedMinutes', unpositioned
    ),
    'diffs', jsonb_build_object(
      'manualOnly', pg_temp.cos_intervals(payable - scheduled_union),
      'scheduledOnly', pg_temp.cos_intervals(scheduled_union - active_tutoring)
    )
  );
END
$fn$;

-- No status or decision fields are changed. All closed sessions on each affected
-- day participate in the calculation, not only the sessions rounded above.
CREATE TEMP TABLE _snap_comparisons ON COMMIT DROP AS
SELECT d.id AS day_id, d.franchiseid, d.tutorid, d.work_date, d.status,
  d.comparison AS previous_comparison,
  pg_temp.cos_comparison(
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'startAt', s.start_at, 'endAt', s.end_at
    ) ORDER BY s.start_at, s.id)
      FROM public.time_entry_sessions s
      WHERE s.entry_day_id = d.id AND s.end_at IS NOT NULL), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id)
      FROM public.time_entry_breaks b WHERE b.entry_day_id = d.id), '[]'::jsonb),
    d.schedule_snapshot->'intervals'
  ) AS new_comparison
FROM public.time_entry_days d
WHERE d.id IN (SELECT entry_day_id FROM _snap_changes);

-- Do not commit corrected times with a missing/invalid recalculation.
DO $check_calculation$
BEGIN
  IF EXISTS (SELECT 1 FROM _snap_comparisons WHERE new_comparison IS NULL) THEN
    RAISE EXCEPTION 'Cannot recalculate a changed day: missing/invalid schedule intervals or session timestamps. Roll back and correct the data first.';
  END IF;
END
$check_calculation$;

UPDATE public.time_entry_days d
SET comparison = c.new_comparison, updated_at = NOW()
FROM _snap_comparisons c
WHERE d.id = c.day_id;

-- Review these results. Timestamps are displayed in UTC.
SELECT franchiseid, tutorid, work_date, session_id, previous_end_at, rounded_end_at,
  extract(epoch FROM (rounded_end_at - previous_end_at)) / 60 AS end_time_change_minutes
FROM _snap_changes
ORDER BY franchiseid, work_date, tutorid, session_id;

SELECT franchiseid, tutorid, work_date, day_id, status,
  previous_comparison#>>'{manual,paidMinutes}' AS previous_stored_paid_minutes,
  new_comparison#>>'{manual,paidMinutes}' AS recalculated_paid_minutes,
  new_comparison->'matches' AS schedule_matches
FROM _snap_comparisons
ORDER BY franchiseid, work_date, tutorid, day_id;

ROLLBACK; -- Trial run: undo both updates. Change this to COMMIT to save both updates.
