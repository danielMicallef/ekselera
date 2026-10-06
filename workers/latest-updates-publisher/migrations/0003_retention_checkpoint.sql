ALTER TABLE jobs ADD COLUMN cleaned_at INTEGER;
CREATE INDEX jobs_retention ON jobs(cleaned_at, created);
