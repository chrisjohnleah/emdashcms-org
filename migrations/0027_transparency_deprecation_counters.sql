-- Phase 22 (EHAA-01): add lifecycle event counters to transparency_weeks.
--
-- deprecations_count and unlists_count follow the same event-in-window
-- semantics as the existing counter columns (versions_submitted,
-- reports_filed_*, etc.). Backfill is forward-only — pre-migration
-- weeks keep DEFAULT 0; the renderer carries a footnote (Phase 22-02)
-- explaining the metric start week.
--
-- D-02 caveat (deprecate→undeprecate within the same week reads as
-- zero events) is documented in src/lib/transparency/transparency-queries.ts
-- and pinned by a unit test in 22-01. Out of scope to add an event log.

ALTER TABLE transparency_weeks
  ADD COLUMN deprecations_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE transparency_weeks
  ADD COLUMN unlists_count INTEGER NOT NULL DEFAULT 0;
