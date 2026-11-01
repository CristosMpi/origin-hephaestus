CREATE TABLE requests (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, application TEXT NOT NULL, type TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Submitted', author TEXT NOT NULL, feedback_json TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 destination TEXT NOT NULL, proposal_json TEXT, approved_commit TEXT, approved_destination TEXT,
 approved_by TEXT, approved_at TEXT, push_claim TEXT, pushed_at TEXT, pr_url TEXT,
 review_started_at TEXT, first_ready_at TEXT, validation_first INTEGER, first_review_accepted INTEGER,
 version INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL,
 CHECK(status IN ('Submitted','Analyzing','Implementing','Validating','Awaiting approval','Changes requested','Rejected','Pushed','Failed')),
 CHECK(pushed_at IS NULL OR (approved_commit IS NOT NULL AND approved_by IS NOT NULL AND approved_destination = destination))
);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES requests(id), kind TEXT NOT NULL, actor TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, data_json TEXT);
CREATE TABLE proposals (request_id TEXT NOT NULL REFERENCES requests(id), revision INTEGER NOT NULL, commit_sha TEXT NOT NULL, proposal_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(request_id, revision));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, actor TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','reviewer','admin')), expires_at TEXT NOT NULL);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
CREATE TABLE reviewers (email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('reviewer','admin')));
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE INDEX requests_status ON requests(status, created_at);
CREATE INDEX events_request ON events(request_id, id);
CREATE TRIGGER invalidate_approval AFTER UPDATE OF proposal_json, destination ON requests
WHEN (NEW.proposal_json IS NOT OLD.proposal_json OR NEW.destination IS NOT OLD.destination)
BEGIN
 UPDATE requests SET approved_commit=NULL, approved_destination=NULL, approved_by=NULL, approved_at=NULL, push_claim=NULL WHERE id=NEW.id;
END;
CREATE TRIGGER prevent_edit_during_publish BEFORE UPDATE OF proposal_json, destination ON requests
WHEN OLD.push_claim IS NOT NULL OR OLD.pushed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Proposal is locked for publication'); END;
CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
