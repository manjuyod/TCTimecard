-- Break and break-rule support for time-entry punches.
-- Separate break rows preserve core shift intervals while capturing lunch/personal breaks.

CREATE TABLE IF NOT EXISTS public.time_entry_break_rules (
  franchiseid INTEGER PRIMARY KEY,
  break_rules_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  auto_lunch_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  auto_lunch_after_minutes INTEGER NOT NULL DEFAULT 360,
  auto_lunch_duration_minutes INTEGER NOT NULL DEFAULT 30,
  auto_lunch_pay_treatment TEXT NOT NULL DEFAULT 'unpaid',
  auto_lunch_break_type TEXT NOT NULL DEFAULT 'lunch',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT time_entry_break_rules_auto_lunch_after_minutes_chk
    CHECK (auto_lunch_after_minutes > 0),
  CONSTRAINT time_entry_break_rules_auto_lunch_duration_minutes_chk
    CHECK (auto_lunch_duration_minutes > 0),
  CONSTRAINT time_entry_break_rules_auto_lunch_pay_treatment_chk
    CHECK (auto_lunch_pay_treatment IN ('paid', 'unpaid')),
  CONSTRAINT time_entry_break_rules_auto_lunch_break_type_chk
    CHECK (auto_lunch_break_type IN ('lunch', 'rest_break', 'personal', 'training', 'travel', 'other'))
);

CREATE TABLE IF NOT EXISTS public.time_entry_breaks (
  id SERIAL PRIMARY KEY,
  entry_day_id INTEGER NOT NULL REFERENCES public.time_entry_days(id) ON DELETE CASCADE,
  time_entry_session_id INTEGER REFERENCES public.time_entry_sessions(id) ON DELETE SET NULL,
  franchiseid INTEGER NOT NULL,
  tutorid INTEGER NOT NULL,
  start_time TIMESTAMPTZ NULL,
  end_time TIMESTAMPTZ NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  break_type TEXT NOT NULL,
  pay_treatment TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT time_entry_breaks_break_type_chk
    CHECK (break_type IN ('lunch', 'rest_break', 'personal', 'training', 'travel', 'other')),
  CONSTRAINT time_entry_breaks_pay_treatment_chk
    CHECK (pay_treatment IN ('paid', 'unpaid')),
  CONSTRAINT time_entry_breaks_source_chk
    CHECK (source IN ('employee', 'manager', 'auto_rule', 'import')),
  CONSTRAINT time_entry_breaks_status_chk
    CHECK (status IN ('active', 'completed', 'voided')),
  CONSTRAINT time_entry_breaks_duration_chk
    CHECK (duration_minutes >= 0),
  CONSTRAINT time_entry_breaks_completed_duration_chk
    CHECK (status <> 'completed' OR duration_minutes > 0),
  CONSTRAINT time_entry_breaks_active_has_start_chk
    CHECK (status <> 'active' OR start_time IS NOT NULL),
  CONSTRAINT time_entry_breaks_window_chk
    CHECK (
      status = 'active'
      OR (
        status IN ('completed', 'voided')
        AND (
          (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
          OR (start_time IS NULL AND end_time IS NULL)
        )
      )
    )
);

CREATE INDEX IF NOT EXISTS time_entry_breaks_entry_day_id_idx
  ON public.time_entry_breaks (entry_day_id);
CREATE INDEX IF NOT EXISTS time_entry_breaks_time_entry_session_id_idx
  ON public.time_entry_breaks (time_entry_session_id);
CREATE INDEX IF NOT EXISTS time_entry_breaks_franchise_tutor_start_time_idx
  ON public.time_entry_breaks (franchiseid, tutorid, start_time);
CREATE INDEX IF NOT EXISTS time_entry_breaks_status_idx
  ON public.time_entry_breaks (status);
CREATE UNIQUE INDEX IF NOT EXISTS time_entry_breaks_one_active_per_day_uniq
  ON public.time_entry_breaks (entry_day_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS time_entry_break_rules_updated_at_idx
  ON public.time_entry_break_rules (updated_at);
