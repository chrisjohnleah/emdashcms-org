-- Workers AI Async Batch API support for the audit pipeline.
--
-- Context: Slow / premium models (Llama 3.3 70B, Qwen3 30B, future Gemma
-- 4 26B) cannot complete within the 30-second sync Worker wall clock on
-- the free tier. Cloudflare's Async Batch API
-- (https://developers.cloudflare.com/workers-ai/features/batch-api/)
-- lets us submit with `queueRequest: true`, receive a `request_id`
-- immediately, ack the audit queue message, and poll for the result via
-- a cron trigger — no long-running Worker invocation needed.
--
-- This migration adds three columns to `plugin_audits` so a single
-- audit row can live through the full submit → queued → running → done
-- lifecycle, and an index so the polling cron can find pending rows
-- cheaply. No existing rows are touched; all three columns default to
-- null/0 for sync audits that never use batch.

ALTER TABLE plugin_audits ADD COLUMN batch_request_id TEXT;
ALTER TABLE plugin_audits ADD COLUMN batch_submitted_at TEXT;
ALTER TABLE plugin_audits ADD COLUMN batch_polls INTEGER NOT NULL DEFAULT 0;

-- Partial index: only rows with a batch_request_id AND status='pending'
-- are candidates for polling. Excludes the vast majority of audit rows
-- (sync audits, completed batch audits) so the polling query stays O(1)
-- on a marketplace with thousands of historical audits.
CREATE INDEX idx_plugin_audits_pending_batch
  ON plugin_audits(batch_submitted_at)
  WHERE batch_request_id IS NOT NULL AND status = 'pending';
