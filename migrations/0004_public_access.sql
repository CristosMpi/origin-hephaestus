ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy' CHECK(kind IN ('legacy','visitor','admin'));
ALTER TABLE sessions ADD COLUMN credential_hash TEXT;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE UNIQUE INDEX events_job_queued ON events(request_id,kind,message) WHERE kind='Job queued';
