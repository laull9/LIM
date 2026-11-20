module;
#include <algorithm>
#include <cstddef>
#include <expected>
#include <limits>
#include <memory>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

module lim.storage;
import :database;
import :schema;

namespace lim {
namespace {

using namespace storage_detail;

constexpr Sequence kSchemaVersion = 1;
constexpr Sequence kText = 0;
constexpr Sequence kJson = 1;
constexpr Sequence kBinary = 2;

static_assert(kMessageBytes == 65536);

std::unexpected<Failure> fail(Error code, std::optional<Sequence> sequence = std::nullopt) {
    return std::unexpected(Failure{code, sequence});
}

Id decode_id(Bytes bytes) {
    Id id;
    if (bytes.size() != id.bytes.size()) {
        throw DatabaseError{};
    }
    std::ranges::copy(bytes, id.bytes.begin());
    return id;
}

std::optional<Sequence> encode_format(HostContent format) {
    switch (format) {
    case HostContent::Text:
        return kText;
    case HostContent::Json:
        return kJson;
    case HostContent::Binary:
        return kBinary;
    }
    return std::nullopt;
}

HostContent decode_format(Sequence format) {
    switch (format) {
    case kText:
        return HostContent::Text;
    case kJson:
        return HostContent::Json;
    case kBinary:
        return HostContent::Binary;
    default:
        throw DatabaseError{};
    }
}

void apply_schema(Database& db, std::string sql) {
    const auto replace = [&sql](std::string_view from, std::string_view to) {
        for (auto pos = sql.find(from); pos != std::string::npos; pos = sql.find(from, pos)) {
            sql.replace(pos, from.size(), to);
            pos += to.size();
        }
    };
    if (db.is_postgres()) {
        replace("BLOB", "BYTEA");
        replace("INTEGER", "BIGINT");
    }
    replace("@strict@", db.is_postgres() ? "" : "STRICT");
    db.script(sql.c_str());
}

class Transaction {
  public:
    Transaction(Database& db, TransactionMode mode) : db_(db) { db_.begin(mode); }

    Transaction(const Transaction&) = delete;
    Transaction& operator=(const Transaction&) = delete;

    ~Transaction() {
        if (active_) {
            db_.rollback();
        }
    }

    void commit() {
        db_.script("COMMIT");
        active_ = false;
    }

  private:
    Database& db_;
    bool active_ = true;
};

std::expected<void, StorageOpenError> initialize(Database& db, Id generation) {
    Transaction transaction(db, TransactionMode::Migration);
    if (db.is_postgres()) {
        // Database-local lock also covers the first open when there is no metadata row yet.
        db.exec("SELECT pg_advisory_xact_lock(1279872257)");
    }
    apply_schema(db, kMetadataSchema);
    auto rows = db.query("SELECT version, generation FROM lim_metadata WHERE singleton = 1", {});
    if (rows->next()) {
        if (rows->integer(0) != kSchemaVersion) {
            return std::unexpected(StorageOpenError::UnsupportedSchema);
        }
        if (decode_id(rows->bytes(1)) != generation) {
            return std::unexpected(StorageOpenError::GenerationMismatch);
        }
        rows.reset();
    } else {
        rows.reset();
        apply_schema(db, kSchemaV1);
        db.exec("INSERT INTO lim_metadata(singleton, version, generation) VALUES (1, $1, $2)",
                {kSchemaVersion, Bytes(generation.bytes)});
    }
    transaction.commit();
    return {};
}

struct Room {
    Sequence last_seq;
    Sequence retained_after;
    Sequence joined_after;
};

class SqlStore final : public Store {
  public:
    explicit SqlStore(std::unique_ptr<Database> db) : db_(std::move(db)) {}

    Result<ConversationSummary> conversation_summary(const Session& session,
                                                     Id conversation) override;
    Result<void> check_generation(Id generation) override;
    Result<void> check_session(const Session& session) override;
    Result<ConversationPage> list_conversations(const Session& session,
                                                std::optional<Id> after) override;
    Result<void> register_device(const Session& session) override;
    Result<void> revoke_device(Id device) override;
    Result<void> create_host_conversation(Id conversation) override;
    Result<void> set_member(Id conversation, Id device, bool active) override;
    Result<void> expire_through(Id conversation, Sequence through) override;
    Result<Receipt> append(const Session& session, const Append& cmd) override;
    Result<Page> read(const Session& session, const Read& query) override;

  private:
    template <typename Operation> auto transact(TransactionMode mode, Operation&& operation) {
        using Return = decltype(operation());
        try {
            Transaction transaction(*db_, mode);
            if (db_->is_postgres() && mode == TransactionMode::Write) {
                // Keep membership changes, credential revocation and appends in one order,
                // even when the host opens multiple handles.
                db_->exec("SELECT singleton FROM lim_metadata WHERE singleton = 1 FOR UPDATE");
            }
            auto result = operation();
            if (result) {
                transaction.commit();
            }
            return result;
        } catch (const DatabaseError& error) {
            return Return(fail(error.busy ? Error::Overloaded : Error::TemporarilyUnavailable));
        }
    }

    Result<void> verify_generation(Id generation);
    Result<void> authenticate(const Session& session);
    Result<Room> authorized_room(const Session& session, Id conversation);

    std::unique_ptr<Database> db_;
};

Result<void> SqlStore::verify_generation(Id generation) {
    auto rows = db_->query("SELECT generation FROM lim_metadata WHERE singleton = 1", {});
    if (!rows->next()) {
        throw DatabaseError{};
    }
    if (decode_id(rows->bytes(0)) != generation) {
        return fail(Error::RecoveryRequired);
    }
    return {};
}

Result<void> authenticate_row(Rows& rows, const Session& session) {
    if (!rows.next() || !std::ranges::equal(rows.bytes(0), session.account.bytes) ||
        !std::ranges::equal(rows.bytes(1), session.credential.bytes)) {
        return fail(Error::Unauthenticated);
    }
    if (rows.integer(2) != 0) {
        return fail(Error::DeviceRevoked);
    }
    if (decode_id(rows.bytes(3)) != session.generation) {
        return fail(Error::RecoveryRequired);
    }
    return {};
}

Result<void> SqlStore::authenticate(const Session& session) {
    auto rows = db_->query(R"SQL(
        SELECT d.account, d.credential, d.revoked, g.generation
        FROM lim_device d LEFT JOIN lim_metadata g ON g.singleton = 1
        WHERE d.id = $1
    )SQL",
                           {Bytes(session.device.bytes)});
    return authenticate_row(*rows, session);
}

Result<Room> SqlStore::authorized_room(const Session& session, Id conversation) {
    auto rows = db_->query(R"SQL(
        SELECT d.account, d.credential, d.revoked, g.generation,
               m.conversation, c.last_seq, c.retained_after, m.joined_after
        FROM lim_device d LEFT JOIN lim_metadata g ON g.singleton = 1
        LEFT JOIN lim_member m ON m.device = d.id AND m.conversation = $2
        LEFT JOIN lim_conversation c ON c.id = m.conversation
        WHERE d.id = $1
    )SQL",
                           {Bytes(session.device.bytes), Bytes(conversation.bytes)});
    if (const auto auth = authenticate_row(*rows, session); !auth) {
        return std::unexpected(auth.error());
    }
    if (rows->bytes(4).empty()) {
        return fail(Error::NotFoundOrForbidden);
    }
    return Room{rows->integer(5), rows->integer(6), rows->integer(7)};
}

Result<ConversationSummary> SqlStore::conversation_summary(const Session& session,
                                                           Id conversation) {
    return transact(TransactionMode::Read, [&]() -> Result<ConversationSummary> {
        const auto room = authorized_room(session, conversation);
        if (!room) {
            return std::unexpected(room.error());
        }
        return ConversationSummary{conversation, std::max(room->retained_after, room->joined_after),
                                   room->last_seq};
    });
}

Result<void> SqlStore::check_generation(Id generation) {
    return transact(TransactionMode::Read, [&] { return verify_generation(generation); });
}

Result<void> SqlStore::check_session(const Session& session) {
    return transact(TransactionMode::Read, [&] { return authenticate(session); });
}

Result<ConversationPage> SqlStore::list_conversations(const Session& session,
                                                      std::optional<Id> after) {
    return transact(TransactionMode::Read, [&]() -> Result<ConversationPage> {
        if (const auto auth = authenticate(session); !auth) {
            return std::unexpected(auth.error());
        }
        const auto cursor = after.value_or(Id{});
        auto rows =
            db_->query(R"SQL(
            SELECT c.id, c.retained_after, m.joined_after, c.last_seq
            FROM lim_member m JOIN lim_conversation c ON c.id = m.conversation
            WHERE m.device = $1 AND ($2 = 0 OR m.conversation > $3)
            ORDER BY m.conversation LIMIT $4
        )SQL",
                       {Bytes(session.device.bytes), static_cast<Sequence>(after.has_value()),
                        Bytes(cursor.bytes), static_cast<Sequence>(kPageEvents + 1)});
        ConversationPage page;
        while (rows->next()) {
            if (page.conversations.size() == kPageEvents) {
                page.next_after = page.conversations.back().id;
                break;
            }
            page.conversations.push_back({decode_id(rows->bytes(0)),
                                          std::max(rows->integer(1), rows->integer(2)),
                                          rows->integer(3)});
        }
        return page;
    });
}

Result<void> SqlStore::register_device(const Session& session) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        if (auto generation = verify_generation(session.generation); !generation) {
            return generation;
        }
        db_->exec(R"SQL(
            INSERT INTO lim_device(id, account, credential) VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
        )SQL",
                  {Bytes(session.device.bytes), Bytes(session.account.bytes),
                   Bytes(session.credential.bytes)});
        return authenticate(session);
    });
}

Result<void> SqlStore::revoke_device(Id device) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        auto rows = db_->query("UPDATE lim_device SET revoked = 1 WHERE id = $1 RETURNING revoked",
                               {Bytes(device.bytes)});
        if (!rows->next()) {
            return fail(Error::NotFoundOrForbidden);
        }
        rows.reset();
        db_->exec("DELETE FROM lim_member WHERE device = $1", {Bytes(device.bytes)});
        return {};
    });
}

Result<void> SqlStore::create_host_conversation(Id conversation) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        db_->exec("INSERT INTO lim_conversation(id) VALUES ($1) ON CONFLICT DO NOTHING",
                  {Bytes(conversation.bytes)});
        return {};
    });
}

Result<void> SqlStore::set_member(Id conversation, Id device, bool active) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        auto rows = db_->query(R"SQL(
            SELECT c.last_seq, d.revoked FROM lim_conversation c CROSS JOIN lim_device d
            WHERE c.id = $1 AND d.id = $2
        )SQL",
                               {Bytes(conversation.bytes), Bytes(device.bytes)});
        if (!rows->next()) {
            return fail(Error::NotFoundOrForbidden);
        }
        if (active && rows->integer(1) != 0) {
            return fail(Error::DeviceRevoked);
        }
        const auto floor = rows->integer(0);
        rows.reset();
        if (active) {
            db_->exec(R"SQL(
                INSERT INTO lim_member(conversation, device, joined_after) VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
            )SQL",
                      {Bytes(conversation.bytes), Bytes(device.bytes), floor});
        } else {
            db_->exec("DELETE FROM lim_member WHERE conversation = $1 AND device = $2",
                      {Bytes(conversation.bytes), Bytes(device.bytes)});
        }
        return {};
    });
}

Result<void> SqlStore::expire_through(Id conversation, Sequence through) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        auto rows =
            db_->query("SELECT last_seq, retained_after FROM lim_conversation WHERE id = $1",
                       {Bytes(conversation.bytes)});
        if (!rows->next()) {
            return fail(Error::NotFoundOrForbidden);
        }
        const auto floor = rows->integer(1);
        if (through < 0 || through > rows->integer(0)) {
            return fail(Error::InvalidArgument);
        }
        rows.reset();
        if (through > floor) {
            db_->exec("UPDATE lim_event SET payload = NULL WHERE conversation = $1 "
                      "AND seq > $2 AND seq <= $3",
                      {Bytes(conversation.bytes), floor, through});
            db_->exec("UPDATE lim_conversation SET retained_after = $2 WHERE id = $1",
                      {Bytes(conversation.bytes), through});
        }
        return {};
    });
}

Result<Receipt> SqlStore::append(const Session& session, const Append& cmd) {
    return transact(TransactionMode::Write, [&]() -> Result<Receipt> {
        const auto room = authorized_room(session, cmd.conversation);
        if (!room) {
            return std::unexpected(room.error());
        }
        if (cmd.payload.empty()) {
            return fail(Error::InvalidArgument);
        }
        if (cmd.payload.size() > kMessageBytes) {
            return fail(Error::PayloadTooLarge);
        }
        const auto* format = std::get_if<HostContent>(&cmd.format);
        const auto encoded = format ? encode_format(*format) : std::nullopt;
        auto previous = db_->query(R"SQL(
            SELECT seq, format, payload FROM lim_event
            WHERE conversation = $1 AND device = $2 AND client_key = $3
        )SQL",
                                   {Bytes(cmd.conversation.bytes), Bytes(session.device.bytes),
                                    Bytes(cmd.client_message_id.bytes)});
        if (previous->next()) {
            const auto seq = previous->integer(0);
            if (seq <= room->joined_after) {
                return fail(Error::NotFoundOrForbidden);
            }
            const auto payload = previous->bytes(2);
            if (payload.empty()) {
                return fail(Error::IdempotencyExpired, seq);
            }
            if (!encoded || *encoded != previous->integer(1) ||
                !std::ranges::equal(payload, cmd.payload)) {
                return fail(Error::IdempotencyConflict);
            }
            return Receipt{seq, true};
        }
        previous.reset();
        if (!format) {
            return fail(Error::ProfileMismatch);
        }
        if (!encoded) {
            return fail(Error::InvalidArgument);
        }
        if (room->last_seq == std::numeric_limits<Sequence>::max()) {
            return fail(Error::Overloaded);
        }
        const auto seq = room->last_seq + 1;
        db_->exec(R"SQL(
            INSERT INTO lim_event(conversation, seq, device, client_key, format, payload)
            VALUES ($1, $2, $3, $4, $5, $6)
        )SQL",
                  {Bytes(cmd.conversation.bytes), seq, Bytes(session.device.bytes),
                   Bytes(cmd.client_message_id.bytes), *encoded, cmd.payload});
        db_->exec("UPDATE lim_conversation SET last_seq = $2 WHERE id = $1",
                  {Bytes(cmd.conversation.bytes), seq});
        return Receipt{seq, false};
    });
}

Result<Page> SqlStore::read(const Session& session, const Read& query) {
    return transact(TransactionMode::Read, [&]() -> Result<Page> {
        const auto room = authorized_room(session, query.conversation);
        if (!room) {
            return std::unexpected(room.error());
        }
        const auto up_to = query.up_to.value_or(room->last_seq);
        if (query.after < 0 || up_to < query.after || up_to > room->last_seq) {
            return fail(Error::InvalidArgument);
        }
        const auto floor = std::max(room->retained_after, room->joined_after);
        if (query.after < floor) {
            return fail(Error::CursorExpired, floor);
        }
        Page page{up_to, {}};
        if (up_to == query.after) {
            return page;
        }
        // Charge the maximum encoded header plus both length prefixes per record.
        // Bound the result in SQL so libpq does not buffer an oversized page.
        constexpr auto overhead = static_cast<Sequence>(kHeaderBytes + 8);
        auto rows = db_->query(R"SQL(
            WITH candidates AS (
                SELECT seq, length(payload) AS payload_bytes
                FROM lim_event WHERE conversation = $1 AND seq > $2 AND seq <= $3
                ORDER BY seq LIMIT $4
            ), sized AS (
                SELECT seq, SUM(payload_bytes + $5) OVER (ORDER BY seq) AS page_bytes
                FROM candidates
            )
            SELECT e.seq, e.device, e.client_key, e.format, e.payload
            FROM sized JOIN lim_event e ON e.conversation = $1 AND e.seq = sized.seq
            WHERE sized.page_bytes <= $6 ORDER BY e.seq
        )SQL",
                               {Bytes(query.conversation.bytes), query.after, up_to,
                                static_cast<Sequence>(kPageEvents), overhead,
                                static_cast<Sequence>(kPageBytes)});
        page.events.reserve(static_cast<std::size_t>(
            std::min(up_to - query.after, static_cast<Sequence>(kPageEvents))));
        while (rows->next()) {
            const auto payload = rows->bytes(4);
            page.events.push_back({rows->integer(0),
                                   decode_id(rows->bytes(1)),
                                   decode_id(rows->bytes(2)),
                                   EventKind::Message,
                                   decode_format(rows->integer(3)),
                                   {payload.begin(), payload.end()}});
        }
        return page;
    });
}

} // namespace

namespace {

std::expected<std::unique_ptr<Database>, StorageOpenError>
connect_store(const StorageOptions& options, bool create) {
    try {
        if (const auto* sqlite = std::get_if<SqliteOptions>(&options)) {
            const auto path = sqlite->file.u8string();
            if (path.empty() || path == u8":memory:" || path.find(u8'\0') != path.npos) {
                return std::unexpected(StorageOpenError::InvalidConfiguration);
            }
            return connect_sqlite(sqlite->file, create);
        }
        const auto& info = std::get<PostgresOptions>(options).connection_info;
        if (info.empty() || info.find('\0') != info.npos) {
            return std::unexpected(StorageOpenError::InvalidConfiguration);
        }
        return connect_postgres(info);
    } catch (const DatabaseError&) {
        return std::unexpected(StorageOpenError::ConnectionFailed);
    }
}

std::expected<void, StorageOpenError> apply_recovery(Database& db,
                                                     const StorageRecovery& recovery) {
    Transaction transaction(db, TransactionMode::Write);
    auto metadata =
        db.query(db.is_postgres()
                     ? "SELECT version, generation FROM lim_metadata WHERE singleton=1 FOR UPDATE"
                     : "SELECT version, generation FROM lim_metadata WHERE singleton=1",
                 {});
    if (!metadata->next() || metadata->integer(0) != kSchemaVersion) {
        return std::unexpected(StorageOpenError::UnsupportedSchema);
    }
    if (decode_id(metadata->bytes(1)) != recovery.snapshot_generation) {
        return std::unexpected(StorageOpenError::GenerationMismatch);
    }
    metadata.reset();

    for (const auto& session : recovery.reviewed_devices) {
        auto device = db.query("SELECT account, revoked FROM lim_device WHERE id = $1",
                               {Bytes(session.device.bytes)});
        if (!device->next() || decode_id(device->bytes(0)) != session.account ||
            device->integer(1) != 0) {
            return std::unexpected(StorageOpenError::RecoveryDeviceMismatch);
        }
        if (db.query("SELECT 1 FROM lim_device WHERE credential = $1",
                     {Bytes(session.credential.bytes)})
                ->next()) {
            return std::unexpected(StorageOpenError::RecoveryCredentialReuse);
        }
    }
    db.exec("UPDATE lim_device SET revoked = 1 WHERE revoked = 0");
    for (const auto& session : recovery.reviewed_devices) {
        db.exec("UPDATE lim_device SET credential = $2, revoked = 0 WHERE id = $1",
                {Bytes(session.device.bytes), Bytes(session.credential.bytes)});
    }
    db.exec("DELETE FROM lim_member WHERE device IN (SELECT id FROM lim_device WHERE revoked = 1)");
    db.exec("UPDATE lim_metadata SET generation = $1 WHERE singleton = 1",
            {Bytes(recovery.new_generation.bytes)});
    transaction.commit();
    return {};
}

} // namespace

std::expected<std::unique_ptr<Store>, StorageOpenError> open_store(const StorageOptions& options,
                                                                   Id generation) {
    auto db = connect_store(options, true);
    if (!db) {
        return std::unexpected(db.error());
    }
    try {
        (*db)->configure();
        if (auto initialized = initialize(**db, generation); !initialized) {
            return std::unexpected(initialized.error());
        }
        return std::make_unique<SqlStore>(std::move(*db));
    } catch (const DatabaseError&) {
        return std::unexpected(StorageOpenError::InitializationFailed);
    }
}

std::expected<void, StorageOpenError> recover_store(const StorageOptions& options,
                                                    const StorageRecovery& recovery) {
    if (recovery.snapshot_generation == Id{} || recovery.new_generation == Id{} ||
        recovery.snapshot_generation == recovery.new_generation) {
        return std::unexpected(StorageOpenError::InvalidConfiguration);
    }
    const auto sessions = recovery.reviewed_devices;
    for (std::size_t i = 0; i < sessions.size(); ++i) {
        const auto& session = sessions[i];
        if (session.generation != recovery.new_generation || session.device == Id{} ||
            session.account == Id{} || session.credential == Id{} ||
            std::ranges::any_of(sessions.first(i), [&](const Session& known) {
                return known.device == session.device || known.credential == session.credential;
            })) {
            return std::unexpected(StorageOpenError::InvalidConfiguration);
        }
    }
    auto db = connect_store(options, false);
    if (!db) {
        return std::unexpected(db.error());
    }
    try {
        (*db)->configure();
        return apply_recovery(**db, recovery);
    } catch (const DatabaseError&) {
        return std::unexpected(StorageOpenError::InitializationFailed);
    }
}

} // namespace lim
