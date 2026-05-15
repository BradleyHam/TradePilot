-- =============================================================
-- Migration 004 — Quote scope + outcome fields on jobs
-- =============================================================
-- Foundation for the "estimating coach" workflow. We capture enough
-- structure on each quoted job to compare like-with-like later:
--   * What kind of work was it (work_type)
--   * Roughly how big (surface_area_m2)
--   * How much prep (prep_level)
-- And once it resolves, why we won or lost it.
--
-- All fields are nullable: existing rows stay untouched; new rows can
-- be created without filling these in. The UI nags rather than blocks.
--
-- Free-form text columns (no CHECK constraints) for `work_type`,
-- `prep_level`, `lost_reason`, `won_reason` so we can evolve enum values
-- in TypeScript without another migration.

alter table jobs
  add column if not exists work_type        text,
  add column if not exists surface_area_m2  numeric(8, 2),
  add column if not exists prep_level       text,
  -- Only one of lost_reason / won_reason is ever populated. Both null
  -- until the job's status moves to lost or accepted.
  add column if not exists lost_reason      text,
  add column if not exists won_reason       text,
  add column if not exists outcome_notes    text;

create index if not exists jobs_work_type_idx on jobs(work_type);
