module;
#include <algorithm>
#include <array>
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
#include <vector>

module lim.storage;
import :database;
import :schema;

namespace lim {
namespace {

using namespace storage_detail;

constexpr Sequence kSchemaVersion = 2;
constexpr Sequence kText = 0;
constexpr Sequence kJson = 1;
constexpr Sequence kBinary = 2;

static_assert(kMessageBytes == 65536);

std::unexpected<Failure> fail(Error code, std::optional<Sequence> sequence = std::nullopt) {
    return std::unexpected(Failure{code, sequence});
}

Bytes blob(const Id& id) {
    return std::as_bytes(std::span(id.bytes));
}

Bytes blob(const SecretDigest& digest) {
    return std::as_bytes(std::span(digest));
}

std::string_view view(const std::string& text) {
    return std::string_view(text);
}

std::string text(Rows& rows, int column) {
    return std::string(rows.text(column));
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
        db.exec("SELECT pg_advisory_xact_lock(1279872257)");
    }
    apply_schema(db, kMetadataSchema);
    auto rows = db.query("SELECT version, generation FROM lim_metadata WHERE singleton = 1", {});
    if (rows->next()) {
        const auto version = rows->integer(0);
        if (decode_id(rows->bytes(1)) != generation) {
            return std::unexpected(StorageOpenError::GenerationMismatch);
        }
        if (version == 1) {
            rows.reset();
            apply_schema(db, kMigrationV2);
        } else if (version != kSchemaVersion) {
            return std::unexpected(StorageOpenError::UnsupportedSchema);
        }
    } else {
        rows.reset();
        apply_schema(db, kSchemaV2);
        db.exec("INSERT INTO lim_metadata(singleton, version, generation) VALUES (1, $1, $2)",
                {kSchemaVersion, blob(generation)});
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
    Result<StoredAccount> create_account(Id id, std::string_view username,
                                         std::string_view display_name,
                                         std::string_view password_hash) override;
    Result<StoredAccount> account_by_username(std::string_view username) override;
    Result<AuthContext> create_login(Id login, Id account, Id device,
                                     std::string_view device_name, Id credential,
                                     SecretDigest access_digest, SecretDigest refresh_digest,
                                     Sequence now, Sequence access_expires,
                                     Sequence refresh_expires) override;
    Result<AuthContext> rotate_login(SecretDigest old_refresh, SecretDigest access_digest,
                                     SecretDigest refresh_digest, Sequence now,
                                     Sequence access_expires,
                                     Sequence refresh_expires) override;
    Result<AuthContext> access_session(SecretDigest access_digest, Sequence now) override;
    Result<void> logout(Id login, Id account) override;
    Result<std::vector<AccountProfile>> search_accounts(const Session& session,
                                                         std::string_view prefix,
                                                         Sequence limit) override;
    Result<ConversationSummary> start_conversation(const Session& session, Id conversation,
                                                   std::span<const Id> targets,
                                                   std::string_view kind, std::string_view title,
                                                   std::string_view direct_key) override;
    Result<std::vector<DeviceSummary>> list_devices(const Session& session) override;
    Result<void> remove_device(const Session& session, Id device) override;

  private:
    template <typename Operation> auto transact(TransactionMode mode, Operation&& operation) {
        using Return = decltype(operation());
        try {
            Transaction transaction(*db_, mode);
            if (db_->is_postgres() && mode == TransactionMode::Write) {
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
    Result<std::vector<AccountProfile>> conversation_members(Id conversation);

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
                           {blob(session.device)});
    return authenticate_row(*rows, session);
}

Result<Room> SqlStore::authorized_room(const Session& session, Id conversation) {
    auto rows = db_->query(R"SQL(
        SELECT d.account, d.credential, d.revoked, g.generation
        FROM lim_device d LEFT JOIN lim_metadata g ON g.singleton = 1
        WHERE d.id = $1
    )SQL",
                           {blob(session.device)});
    if (const auto auth = authenticate_row(*rows, session); !auth) {
        return std::unexpected(auth.error());
    }
    rows.reset();
    auto account_member = db_->query(R"SQL(
        SELECT joined_after FROM lim_account_member
        WHERE conversation = $1 AND account = $2
    )SQL",
                                     {blob(conversation), blob(session.account)});
    Sequence joined_after = 0;
    bool allowed = false;
    if (account_member->next()) {
        joined_after = account_member->integer(0);
        allowed = true;
    }
    account_member.reset();
    auto device_member = db_->query(R"SQL(
        SELECT joined_after FROM lim_member WHERE conversation = $1 AND device = $2
    )SQL",
                                    {blob(conversation), blob(session.device)});
    if (device_member->next()) {
        joined_after = std::max(joined_after, device_member->integer(0));
        allowed = true;
    }
    device_member.reset();
    if (!allowed) {
        return fail(Error::NotFoundOrForbidden);
    }
    auto room = db_->query("SELECT last_seq, retained_after FROM lim_conversation WHERE id = $1",
                           {blob(conversation)});
    if (!room->next()) {
        return fail(Error::NotFoundOrForbidden);
    }
    return Room{room->integer(0), room->integer(1), joined_after};
}

Result<std::vector<AccountProfile>> SqlStore::conversation_members(Id conversation) {
    auto rows = db_->query(R"SQL(
        SELECT a.id, a.username, a.display_name
        FROM lim_account_member m JOIN lim_account a ON a.id = m.account
        WHERE m.conversation = $1 AND a.username IS NOT NULL
        ORDER BY a.username
    )SQL",
                           {blob(conversation)});
    std::vector<AccountProfile> members;
    while (rows->next()) {
        members.push_back({decode_id(rows->bytes(0)), text(*rows, 1), text(*rows, 2)});
    }
    return members;
}

Result<ConversationSummary> SqlStore::conversation_summary(const Session& session,
                                                           Id conversation) {
    return transact(TransactionMode::Read, [&]() -> Result<ConversationSummary> {
        const auto room = authorized_room(session, conversation);
        if (!room) {
            return std::unexpected(room.error());
        }
        ConversationSummary summary{};
        summary.id = conversation;
        summary.after = std::max(room->retained_after, room->joined_after);
        summary.last_seq = room->last_seq;
        return summary;
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
        auto rows = db_->query(R"SQL(
            WITH scoped AS (
                SELECT conversation, joined_after, CAST(1 AS BIGINT) AS scoped
                FROM lim_account_member WHERE account = $1
                UNION ALL
                SELECT m.conversation, m.joined_after, CAST(0 AS BIGINT)
                FROM lim_member m JOIN lim_device d ON d.id = m.device
                WHERE d.id = $2 AND d.account = $1
            )
            SELECT c.id, c.retained_after, MAX(scoped.joined_after), c.last_seq,
                   MAX(scoped.scoped), c.kind, c.title
            FROM scoped JOIN lim_conversation c ON c.id = scoped.conversation
            WHERE ($3 = 0 OR c.id > $4)
            GROUP BY c.id, c.retained_after, c.last_seq, c.kind, c.title
            ORDER BY c.id LIMIT $5
        )SQL",
                               {blob(session.account), blob(session.device),
                                static_cast<Sequence>(after.has_value()), blob(cursor),
                                static_cast<Sequence>(kPageEvents + 1)});
        ConversationPage page;
        std::vector<ConversationSummary> summaries;
        while (rows->next()) {
            if (summaries.size() == kPageEvents) {
                page.next_after = summaries.back().id;
                break;
            }
            ConversationSummary summary{};
            summary.id = decode_id(rows->bytes(0));
            summary.after = std::max(rows->integer(1), rows->integer(2));
            summary.last_seq = rows->integer(3);
            summary.kind = text(*rows, 5);
            summary.title = text(*rows, 6);
            summary.account_scoped = rows->integer(4) != 0;
            summaries.push_back(std::move(summary));
        }
        rows.reset();
        for (auto& summary : summaries) {
            if (summary.account_scoped) {
                const auto members = conversation_members(summary.id);
                if (!members) {
                    return std::unexpected(members.error());
                }
                summary.members = *members;
            }
            page.conversations.push_back(std::move(summary));
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
            INSERT INTO lim_account(id, display_name) VALUES ($1, '预配置账号')
            ON CONFLICT DO NOTHING
        )SQL",
                  {blob(session.account)});
        db_->exec(R"SQL(
            INSERT INTO lim_device(id, account, credential, name) VALUES ($1, $2, $3, '预配置设备')
            ON CONFLICT DO NOTHING
        )SQL",
                  {blob(session.device), blob(session.account), blob(session.credential)});
        return authenticate(session);
    });
}

Result<void> SqlStore::revoke_device(Id device) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        auto rows = db_->query("UPDATE lim_device SET revoked = 1 WHERE id = $1 RETURNING revoked",
                               {blob(device)});
        if (!rows->next()) {
            return fail(Error::NotFoundOrForbidden);
        }
        rows.reset();
        db_->exec("DELETE FROM lim_member WHERE device = $1", {blob(device)});
        db_->exec("UPDATE lim_auth_session SET revoked = 1 WHERE device = $1", {blob(device)});
        return {};
    });
}

Result<void> SqlStore::create_host_conversation(Id conversation) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        db_->exec("INSERT INTO lim_conversation(id) VALUES ($1) ON CONFLICT DO NOTHING",
                  {blob(conversation)});
        return {};
    });
}

Result<void> SqlStore::set_member(Id conversation, Id device, bool active) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        auto rows = db_->query(R"SQL(
            SELECT c.last_seq, d.revoked FROM lim_conversation c CROSS JOIN lim_device d
            WHERE c.id = $1 AND d.id = $2
        )SQL",
                               {blob(conversation), blob(device)});
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
                      {blob(conversation), blob(device), floor});
        } else {
            db_->exec("DELETE FROM lim_member WHERE conversation = $1 AND device = $2",
                      {blob(conversation), blob(device)});
        }
        return {};
    });
}

Result<void> SqlStore::expire_through(Id conversation, Sequence through) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        auto rows =
            db_->query("SELECT last_seq, retained_after FROM lim_conversation WHERE id = $1",
                       {blob(conversation)});
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
                      {blob(conversation), floor, through});
            db_->exec("UPDATE lim_conversation SET retained_after = $2 WHERE id = $1",
                      {blob(conversation), through});
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
                                   {blob(cmd.conversation), blob(session.device),
                                    blob(cmd.client_message_id)});
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
                  {blob(cmd.conversation), seq, blob(session.device),
                   blob(cmd.client_message_id), *encoded, cmd.payload});
        db_->exec("UPDATE lim_conversation SET last_seq = $2 WHERE id = $1",
                  {blob(cmd.conversation), seq});
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
            SELECT e.seq, e.device, e.client_key, e.format, e.payload,
                   d.account, COALESCE(a.username, ''), COALESCE(a.display_name, '')
            FROM sized JOIN lim_event e ON e.conversation = $1 AND e.seq = sized.seq
            JOIN lim_device d ON d.id = e.device
            LEFT JOIN lim_account a ON a.id = d.account
            WHERE sized.page_bytes <= $6 ORDER BY e.seq
        )SQL",
                               {blob(query.conversation), query.after, up_to,
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
                                   {payload.begin(), payload.end()},
                                   decode_id(rows->bytes(5)),
                                   text(*rows, 6),
                                   text(*rows, 7)});
        }
        return page;
    });
}

Result<StoredAccount> SqlStore::create_account(Id id, std::string_view username,
                                               std::string_view display_name,
                                               std::string_view password_hash) {
    return transact(TransactionMode::Write, [&]() -> Result<StoredAccount> {
        auto existing = db_->query("SELECT 1 FROM lim_account WHERE id = $1 OR username = $2",
                                   {blob(id), username});
        if (existing->next()) {
            return fail(Error::UsernameTaken);
        }
        existing.reset();
        db_->exec(R"SQL(
            INSERT INTO lim_account(id, username, display_name, password_hash)
            VALUES ($1, $2, $3, $4)
        )SQL",
                  {blob(id), username, display_name, password_hash});
        return StoredAccount{id, std::string(username), std::string(display_name),
                             std::string(password_hash)};
    });
}

Result<StoredAccount> SqlStore::account_by_username(std::string_view username) {
    return transact(TransactionMode::Read, [&]() -> Result<StoredAccount> {
        auto rows = db_->query(R"SQL(
            SELECT id, username, display_name, password_hash FROM lim_account
            WHERE username = $1 AND password_hash IS NOT NULL
        )SQL",
                               {username});
        if (!rows->next()) {
            return fail(Error::Unauthenticated);
        }
        return StoredAccount{decode_id(rows->bytes(0)), text(*rows, 1), text(*rows, 2),
                             text(*rows, 3)};
    });
}

Result<AuthContext> SqlStore::create_login(Id login, Id account, Id device,
                                           std::string_view device_name, Id credential,
                                           SecretDigest access_digest,
                                           SecretDigest refresh_digest, Sequence now,
                                           Sequence access_expires, Sequence refresh_expires) {
    return transact(TransactionMode::Write, [&]() -> Result<AuthContext> {
        auto profile = db_->query(R"SQL(
            SELECT username, display_name, g.generation FROM lim_account a
            LEFT JOIN lim_metadata g ON g.singleton = 1 WHERE a.id = $1
        )SQL",
                                  {blob(account)});
        if (!profile->next() || profile->text(0).empty()) {
            return fail(Error::Unauthenticated);
        }
        const auto username = text(*profile, 0);
        const auto display_name = text(*profile, 1);
        const auto generation = decode_id(profile->bytes(2));
        profile.reset();
        db_->exec(R"SQL(
            INSERT INTO lim_device(id, account, credential, name, created_at, last_seen)
            VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT DO NOTHING
        )SQL",
                  {blob(device), blob(account), blob(credential), device_name, now});
        auto device_row = db_->query(R"SQL(
            SELECT account, credential, revoked FROM lim_device WHERE id = $1
        )SQL",
                                     {blob(device)});
        if (!device_row->next() || decode_id(device_row->bytes(0)) != account) {
            return fail(Error::Unauthenticated);
        }
        if (device_row->integer(2) != 0) {
            return fail(Error::DeviceRevoked);
        }
        const auto stored_credential = decode_id(device_row->bytes(1));
        device_row.reset();
        db_->exec("UPDATE lim_device SET last_seen = $2 WHERE id = $1", {blob(device), now});
        db_->exec(R"SQL(
            INSERT INTO lim_auth_session(id, account, device, access_digest, refresh_digest,
                                         access_expires, refresh_expires, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        )SQL",
                  {blob(login), blob(account), blob(device), blob(access_digest),
                   blob(refresh_digest), access_expires, refresh_expires, now});
        return AuthContext{Session{account, device, generation, stored_credential}, login,
                           username, display_name, access_expires, refresh_expires};
    });
}

Result<AuthContext> SqlStore::rotate_login(SecretDigest old_refresh, SecretDigest access_digest,
                                           SecretDigest refresh_digest, Sequence now,
                                           Sequence access_expires, Sequence refresh_expires) {
    return transact(TransactionMode::Write, [&]() -> Result<AuthContext> {
        auto rows = db_->query(R"SQL(
            UPDATE lim_auth_session SET access_digest = $2, refresh_digest = $3,
                access_expires = $4, refresh_expires = $5
            WHERE refresh_digest = $1 AND revoked = 0 AND refresh_expires > $6
            RETURNING id, account, device
        )SQL",
                               {blob(old_refresh), blob(access_digest), blob(refresh_digest),
                                access_expires, refresh_expires, now});
        if (!rows->next()) {
            return fail(Error::Unauthenticated);
        }
        const auto login = decode_id(rows->bytes(0));
        const auto account = decode_id(rows->bytes(1));
        const auto device = decode_id(rows->bytes(2));
        rows.reset();
        auto context = db_->query(R"SQL(
            SELECT a.username, a.display_name, d.credential, d.revoked, g.generation
            FROM lim_account a JOIN lim_device d ON d.account = a.id
            LEFT JOIN lim_metadata g ON g.singleton = 1
            WHERE a.id = $1 AND d.id = $2
        )SQL",
                                  {blob(account), blob(device)});
        if (!context->next() || context->integer(3) != 0) {
            return fail(Error::DeviceRevoked);
        }
        return AuthContext{Session{account, device, decode_id(context->bytes(4)),
                                   decode_id(context->bytes(2))},
                           login, text(*context, 0), text(*context, 1), access_expires,
                           refresh_expires};
    });
}

Result<AuthContext> SqlStore::access_session(SecretDigest access_digest, Sequence now) {
    return transact(TransactionMode::Read, [&]() -> Result<AuthContext> {
        auto rows = db_->query(R"SQL(
            SELECT s.id, d.account, d.id, d.credential, a.username, a.display_name,
                   s.access_expires, s.refresh_expires, d.revoked, s.revoked, g.generation
            FROM lim_auth_session s JOIN lim_device d ON d.id = s.device
            JOIN lim_account a ON a.id = d.account
            LEFT JOIN lim_metadata g ON g.singleton = 1
            WHERE s.access_digest = $1 AND s.access_expires > $2
        )SQL",
                               {blob(access_digest), now});
        if (!rows->next() || rows->integer(9) != 0) {
            return fail(Error::Unauthenticated);
        }
        if (rows->integer(8) != 0) {
            return fail(Error::DeviceRevoked);
        }
        return AuthContext{Session{decode_id(rows->bytes(1)), decode_id(rows->bytes(2)),
                                   decode_id(rows->bytes(10)), decode_id(rows->bytes(3))},
                           decode_id(rows->bytes(0)), text(*rows, 4), text(*rows, 5),
                           rows->integer(6), rows->integer(7)};
    });
}

Result<void> SqlStore::logout(Id login, Id account) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        auto rows = db_->query(R"SQL(
            UPDATE lim_auth_session SET revoked = 1
            WHERE id = $1 AND account = $2 RETURNING id
        )SQL",
                               {blob(login), blob(account)});
        if (!rows->next()) {
            return fail(Error::Unauthenticated);
        }
        return {};
    });
}

Result<std::vector<AccountProfile>> SqlStore::search_accounts(const Session& session,
                                                              std::string_view prefix,
                                                              Sequence limit) {
    return transact(TransactionMode::Read, [&]() -> Result<std::vector<AccountProfile>> {
        if (const auto auth = authenticate(session); !auth) {
            return std::unexpected(auth.error());
        }
        const auto pattern = std::string(prefix) + "%";
        auto rows = db_->query(R"SQL(
            SELECT id, username, display_name FROM lim_account
            WHERE username IS NOT NULL AND username LIKE $1
            ORDER BY username LIMIT $2
        )SQL",
                               {view(pattern), limit});
        std::vector<AccountProfile> accounts;
        while (rows->next()) {
            accounts.push_back({decode_id(rows->bytes(0)), text(*rows, 1), text(*rows, 2)});
        }
        return accounts;
    });
}

Result<ConversationSummary> SqlStore::start_conversation(const Session& session, Id conversation,
                                                         std::span<const Id> targets,
                                                         std::string_view kind,
                                                         std::string_view title,
                                                         std::string_view direct_key) {
    return transact(TransactionMode::Write, [&]() -> Result<ConversationSummary> {
        if (const auto auth = authenticate(session); !auth) {
            return std::unexpected(auth.error());
        }
        if (!verify_generation(session.generation)) {
            return fail(Error::RecoveryRequired);
        }
        if (!direct_key.empty()) {
            auto existing = db_->query(R"SQL(
                SELECT id, last_seq, retained_after FROM lim_conversation
                WHERE direct_key = $1
            )SQL",
                                       {direct_key});
            if (existing->next()) {
                const auto id = decode_id(existing->bytes(0));
                const auto last_seq = existing->integer(1);
                const auto floor = existing->integer(2);
                existing.reset();
                const auto members = conversation_members(id);
                if (!members) {
                    return std::unexpected(members.error());
                }
                return ConversationSummary{id, floor, last_seq, std::string(kind),
                                           std::string(title), *members, true};
            }
            existing.reset();
        }
        std::vector<Id> members;
        members.push_back(session.account);
        for (const auto target : targets) {
            auto found = db_->query(R"SQL(
                SELECT 1 FROM lim_account WHERE id = $1 AND username IS NOT NULL
            )SQL",
                                    {blob(target)});
            if (!found->next()) {
                return fail(Error::NotFoundOrForbidden);
            }
            found.reset();
            if (target != session.account) {
                members.push_back(target);
            }
        }
        db_->exec(R"SQL(
            INSERT INTO lim_conversation(id, kind, title, direct_key, created_by)
            VALUES ($1, $2, $3, NULLIF($4, ''), $5)
        )SQL",
                  {blob(conversation), kind, title, direct_key, blob(session.account)});
        for (const auto member : members) {
            db_->exec(R"SQL(
                INSERT INTO lim_account_member(conversation, account, joined_after)
                VALUES ($1, $2, 0) ON CONFLICT DO NOTHING
            )SQL",
                      {blob(conversation), blob(member)});
        }
        const auto profiles = conversation_members(conversation);
        if (!profiles) {
            return std::unexpected(profiles.error());
        }
        return ConversationSummary{conversation, 0, 0, std::string(kind), std::string(title),
                                   *profiles, true};
    });
}

Result<std::vector<DeviceSummary>> SqlStore::list_devices(const Session& session) {
    return transact(TransactionMode::Read, [&]() -> Result<std::vector<DeviceSummary>> {
        if (const auto auth = authenticate(session); !auth) {
            return std::unexpected(auth.error());
        }
        auto rows = db_->query(R"SQL(
            SELECT id, name, created_at, last_seen, revoked FROM lim_device
            WHERE account = $1 ORDER BY created_at, id
        )SQL",
                               {blob(session.account)});
        std::vector<DeviceSummary> devices;
        while (rows->next()) {
            devices.push_back({decode_id(rows->bytes(0)), text(*rows, 1), rows->integer(2),
                               rows->integer(3), rows->integer(4) != 0});
        }
        return devices;
    });
}

Result<void> SqlStore::remove_device(const Session& session, Id device) {
    return transact(TransactionMode::Write, [&]() -> Result<void> {
        if (const auto auth = authenticate(session); !auth) {
            return auth;
        }
        auto rows = db_->query(R"SQL(
            UPDATE lim_device SET revoked = 1 WHERE id = $1 AND account = $2 RETURNING id
        )SQL",
                               {blob(device), blob(session.account)});
        if (!rows->next()) {
            return fail(Error::NotFoundOrForbidden);
        }
        rows.reset();
        db_->exec("DELETE FROM lim_member WHERE device = $1", {blob(device)});
        db_->exec("UPDATE lim_auth_session SET revoked = 1 WHERE device = $1", {blob(device)});
        return {};
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
    db.exec("UPDATE lim_auth_session SET revoked = 1");
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
