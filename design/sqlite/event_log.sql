-- Executable design for the shared event log. One database per LIM instance.
-- Identity, MLS credentials, catalog and retention jobs belong to later migrations.
CREATE TABLE conversation (
    id BLOB PRIMARY KEY CHECK (length(id) = 16),
    profile TEXT NOT NULL DEFAULT 'mls' CHECK (profile IN ('mls', 'host')),
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    UNIQUE (id, profile)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER immutable_profile BEFORE UPDATE OF profile ON conversation
WHEN NEW.profile <> OLD.profile
BEGIN
    SELECT RAISE(ABORT, 'immutable conversation profile');
END;

CREATE TABLE event (
    conversation_id BLOB NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    profile TEXT NOT NULL,
    device_id BLOB NOT NULL CHECK (length(device_id) = 16),
    client_message_id BLOB NOT NULL CHECK (length(client_message_id) = 16),
    kind TEXT NOT NULL CHECK (kind IN ('message', 'mls.commit')),
    content_type TEXT NOT NULL,
    group_instance BLOB,
    epoch INTEGER,
    payload BLOB, -- NULL is a retention tombstone with its original idempotency key.
    PRIMARY KEY (conversation_id, seq),
    UNIQUE (conversation_id, device_id, client_message_id),
    FOREIGN KEY (conversation_id, profile) REFERENCES conversation(id, profile),
    CHECK ((profile = 'mls' AND content_type = 'mls' AND
            group_instance IS NOT NULL AND length(group_instance) = 16 AND
            epoch IS NOT NULL AND epoch >= 0) OR
           (profile = 'host' AND kind = 'message' AND group_instance IS NULL AND
            epoch IS NULL AND content_type IN ('text/plain', 'application/json',
                                               'application/octet-stream'))),
    CHECK (payload IS NULL OR length(payload) BETWEEN 1 AND
           CASE kind WHEN 'message' THEN 65536 ELSE 1048576 END)
) STRICT, WITHOUT ROWID;

-- The writer reads last_seq in BEGIN IMMEDIATE and supplies its checked successor.
CREATE TRIGGER require_new_payload BEFORE INSERT ON event
WHEN NEW.payload IS NULL
BEGIN
    SELECT RAISE(ABORT, 'new event needs a payload');
END;

CREATE TRIGGER contiguous_event BEFORE INSERT ON event
WHEN NEW.seq <> (SELECT last_seq + 1 FROM conversation WHERE id = NEW.conversation_id)
BEGIN
    SELECT RAISE(ABORT, 'non-contiguous sequence');
END;

CREATE TRIGGER advance_head AFTER INSERT ON event
BEGIN
    UPDATE conversation SET last_seq = NEW.seq WHERE id = NEW.conversation_id;
END;
