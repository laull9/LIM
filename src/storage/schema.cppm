module lim.storage:schema;

namespace lim::storage_detail {

inline constexpr char kMetadataSchema[] = R"SQL(
CREATE TABLE IF NOT EXISTS lim_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version > 0),
    generation BLOB NOT NULL CHECK (length(generation) = 16)
) @strict@;
)SQL";

inline constexpr char kSchemaV1[] = R"SQL(
CREATE TABLE lim_device (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    account BLOB NOT NULL CHECK (length(account) = 16),
    credential BLOB NOT NULL UNIQUE CHECK (length(credential) = 16),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) @strict@;

CREATE TABLE lim_conversation (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    retained_after INTEGER NOT NULL DEFAULT 0 CHECK (retained_after BETWEEN 0 AND last_seq)
) @strict@;

CREATE TABLE lim_member (
    conversation BLOB NOT NULL REFERENCES lim_conversation(id),
    device BLOB NOT NULL REFERENCES lim_device(id),
    joined_after INTEGER NOT NULL CHECK (joined_after >= 0),
    PRIMARY KEY (conversation, device)
) @strict@;

CREATE INDEX lim_member_device ON lim_member(device);

CREATE TABLE lim_event (
    conversation BLOB NOT NULL REFERENCES lim_conversation(id),
    seq INTEGER NOT NULL CHECK (seq > 0),
    device BLOB NOT NULL REFERENCES lim_device(id),
    client_key BLOB NOT NULL CHECK (length(client_key) = 16),
    format INTEGER NOT NULL CHECK (format IN (0, 1, 2)),
    payload BLOB CHECK (payload IS NULL OR length(payload) BETWEEN 1 AND 65536),
    PRIMARY KEY (conversation, seq),
    UNIQUE (conversation, device, client_key)
) @strict@;
)SQL";

inline constexpr char kSchemaV2[] = R"SQL(
CREATE TABLE lim_account (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    username TEXT UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
) @strict@;

CREATE TABLE lim_device (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    account BLOB NOT NULL REFERENCES lim_account(id),
    credential BLOB NOT NULL UNIQUE CHECK (length(credential) = 16),
    name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) @strict@;

CREATE TABLE lim_conversation (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    retained_after INTEGER NOT NULL DEFAULT 0 CHECK (retained_after BETWEEN 0 AND last_seq),
    kind TEXT NOT NULL DEFAULT 'host' CHECK (kind IN ('host', 'direct', 'group')),
    title TEXT NOT NULL DEFAULT '',
    direct_key TEXT UNIQUE,
    created_by BLOB CHECK (created_by IS NULL OR length(created_by) = 16)
) @strict@;

CREATE TABLE lim_member (
    conversation BLOB NOT NULL REFERENCES lim_conversation(id),
    device BLOB NOT NULL REFERENCES lim_device(id),
    joined_after INTEGER NOT NULL CHECK (joined_after >= 0),
    PRIMARY KEY (conversation, device)
) @strict@;

CREATE TABLE lim_account_member (
    conversation BLOB NOT NULL REFERENCES lim_conversation(id),
    account BLOB NOT NULL REFERENCES lim_account(id),
    joined_after INTEGER NOT NULL CHECK (joined_after >= 0),
    PRIMARY KEY (conversation, account)
) @strict@;

CREATE TABLE lim_auth_session (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    account BLOB NOT NULL REFERENCES lim_account(id),
    device BLOB NOT NULL REFERENCES lim_device(id),
    access_digest BLOB NOT NULL UNIQUE CHECK (length(access_digest) = 32),
    refresh_digest BLOB NOT NULL UNIQUE CHECK (length(refresh_digest) = 32),
    access_expires INTEGER NOT NULL,
    refresh_expires INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) @strict@;

CREATE TABLE lim_event (
    conversation BLOB NOT NULL REFERENCES lim_conversation(id),
    seq INTEGER NOT NULL CHECK (seq > 0),
    device BLOB NOT NULL REFERENCES lim_device(id),
    client_key BLOB NOT NULL CHECK (length(client_key) = 16),
    format INTEGER NOT NULL CHECK (format IN (0, 1, 2)),
    payload BLOB CHECK (payload IS NULL OR length(payload) BETWEEN 1 AND 65536),
    PRIMARY KEY (conversation, seq),
    UNIQUE (conversation, device, client_key)
) @strict@;

CREATE INDEX lim_member_device ON lim_member(device);
CREATE INDEX lim_account_member_account ON lim_account_member(account);
CREATE INDEX lim_auth_session_device ON lim_auth_session(device);
CREATE INDEX lim_account_username ON lim_account(username);
)SQL";

inline constexpr char kMigrationV2[] = R"SQL(
CREATE TABLE lim_account (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    username TEXT UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
) @strict@;

INSERT INTO lim_account(id, display_name)
SELECT DISTINCT account, '预配置账号' FROM lim_device;

ALTER TABLE lim_device ADD COLUMN name TEXT NOT NULL DEFAULT '预配置设备';
ALTER TABLE lim_device ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lim_device ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lim_conversation ADD COLUMN kind TEXT NOT NULL DEFAULT 'host';
ALTER TABLE lim_conversation ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE lim_conversation ADD COLUMN direct_key TEXT UNIQUE;
ALTER TABLE lim_conversation ADD COLUMN created_by BLOB;

CREATE TABLE lim_account_member (
    conversation BLOB NOT NULL REFERENCES lim_conversation(id),
    account BLOB NOT NULL REFERENCES lim_account(id),
    joined_after INTEGER NOT NULL CHECK (joined_after >= 0),
    PRIMARY KEY (conversation, account)
) @strict@;

CREATE TABLE lim_auth_session (
    id BLOB NOT NULL PRIMARY KEY CHECK (length(id) = 16),
    account BLOB NOT NULL REFERENCES lim_account(id),
    device BLOB NOT NULL REFERENCES lim_device(id),
    access_digest BLOB NOT NULL UNIQUE CHECK (length(access_digest) = 32),
    refresh_digest BLOB NOT NULL UNIQUE CHECK (length(refresh_digest) = 32),
    access_expires INTEGER NOT NULL,
    refresh_expires INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
) @strict@;

CREATE INDEX lim_account_member_account ON lim_account_member(account);
CREATE INDEX lim_auth_session_device ON lim_auth_session(device);
CREATE INDEX lim_account_username ON lim_account(username);
UPDATE lim_metadata SET version = 2 WHERE singleton = 1;
)SQL";

} // namespace lim::storage_detail
