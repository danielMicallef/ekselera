CREATE TABLE jobs (
 id TEXT PRIMARY KEY, site TEXT NOT NULL, author TEXT NOT NULL, message_key TEXT NOT NULL UNIQUE,
 input_digest TEXT NOT NULL, digest TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('inviting','awaiting_confirmation','confirmed','opening_pr','validating','merging','deploying','live','discarded','expired','failed','needs_attention')),
 draft TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL, published_at TEXT,
 branch TEXT, pr INTEGER, head TEXT, base TEXT, merged_sha TEXT, broadcast_id TEXT,
 notification_state TEXT NOT NULL DEFAULT 'pending', error_code TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 updated INTEGER NOT NULL
);
CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, UNIQUE(kind,job_id));
CREATE TABLE events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, site TEXT NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', confirmed INTEGER, consent_version TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, observed INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX job_reconcile ON jobs(state,updated);
CREATE INDEX subscription_expiry ON subscriptions(expires);
