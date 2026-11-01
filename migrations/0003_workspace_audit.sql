CREATE TABLE workspace_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL, details_json TEXT NOT NULL);
CREATE TRIGGER immutable_workspace_audit_update BEFORE UPDATE ON workspace_audit BEGIN SELECT RAISE(ABORT, 'Workspace audit is append-only'); END;
CREATE TRIGGER immutable_workspace_audit_delete BEFORE DELETE ON workspace_audit BEGIN SELECT RAISE(ABORT, 'Workspace audit is append-only'); END;
