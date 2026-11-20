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

} // namespace lim::storage_detail
