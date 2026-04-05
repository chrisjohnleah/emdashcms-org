-- Add status column for admin moderation (revocation)
ALTER TABLE plugins ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
