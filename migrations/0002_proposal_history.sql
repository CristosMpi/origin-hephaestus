CREATE TRIGGER immutable_proposals_update BEFORE UPDATE ON proposals BEGIN SELECT RAISE(ABORT, 'Proposal history is immutable'); END;
CREATE TRIGGER immutable_proposals_delete BEFORE DELETE ON proposals BEGIN SELECT RAISE(ABORT, 'Proposal history is immutable'); END;
