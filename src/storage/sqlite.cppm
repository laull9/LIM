module;
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <initializer_list>
#include <memory>
#include <span>
#include <sqlite3.h>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <variant>

module lim.storage;
import :database;

namespace lim::storage_detail {
namespace {

void check(int rc) {
    if (rc != SQLITE_OK) {
        throw DatabaseError{(rc & 0xff) == SQLITE_BUSY || (rc & 0xff) == SQLITE_LOCKED};
    }
}

struct Close {
    void operator()(sqlite3* db) const noexcept { sqlite3_close(db); }
};

struct Finalize {
    void operator()(sqlite3_stmt* stmt) const noexcept { sqlite3_finalize(stmt); }
};

struct SqlHash {
    using is_transparent = void;
    std::size_t operator()(std::string_view sql) const noexcept {
        return std::hash<std::string_view>{}(sql);
    }
};

struct Statement {
    std::unique_ptr<sqlite3_stmt, Finalize> stmt;
    bool in_use = false;
};

struct Release {
    Statement* cached = nullptr;

    void operator()(sqlite3_stmt* stmt) const noexcept {
        if (cached) {
            sqlite3_reset(stmt);
            sqlite3_clear_bindings(stmt);
            cached->in_use = false;
        } else {
            sqlite3_finalize(stmt);
        }
    }
};

using StatementLease = std::unique_ptr<sqlite3_stmt, Release>;

class SqliteRows final : public Rows {
  public:
    SqliteRows(StatementLease stmt, std::initializer_list<Parameter> parameters)
        : stmt_(std::move(stmt)) {
        unsigned int position = 1;
        for (const auto& parameter : parameters) {
            const auto name = "$" + std::to_string(position++);
            const auto index = sqlite3_bind_parameter_index(stmt_.get(), name.c_str());
            if (const auto* number = std::get_if<std::int64_t>(&parameter)) {
                check(sqlite3_bind_int64(stmt_.get(), index, *number));
            } else if (const auto* text = std::get_if<std::string_view>(&parameter)) {
                check(sqlite3_bind_text64(stmt_.get(), index, text->data(), text->size(),
                                          SQLITE_TRANSIENT, SQLITE_UTF8));
            } else {
                const auto bytes = std::get<Bytes>(parameter);
                check(sqlite3_bind_blob64(stmt_.get(), index, bytes.data(), bytes.size(),
                                          SQLITE_TRANSIENT));
            }
        }
    }

    bool next() override {
        const auto rc = sqlite3_step(stmt_.get());
        if (rc == SQLITE_DONE) {
            return false;
        }
        if (rc != SQLITE_ROW) {
            check(rc);
        }
        return true;
    }

    std::int64_t integer(int column) const override {
        return sqlite3_column_int64(stmt_.get(), column);
    }

    Bytes bytes(int column) const override {
        const auto* contents =
            static_cast<const std::byte*>(sqlite3_column_blob(stmt_.get(), column));
        const auto size = sqlite3_column_bytes(stmt_.get(), column);
        return {contents, static_cast<std::size_t>(size)};
    }

    std::string_view text(int column) const override {
        const auto* contents =
            reinterpret_cast<const char*>(sqlite3_column_text(stmt_.get(), column));
        const auto size = sqlite3_column_bytes(stmt_.get(), column);
        return size == 0 ? std::string_view{} : std::string_view(contents, size);
    }

  private:
    StatementLease stmt_;
};

class SqliteDatabase final : public Database {
  public:
    explicit SqliteDatabase(std::unique_ptr<sqlite3, Close> db) : db_(std::move(db)) {}

    bool is_postgres() const override { return false; }

    void configure() override {
        check(sqlite3_busy_timeout(db_.get(), 2000));
        auto rows = query("PRAGMA journal_mode=WAL", {});
        if (!rows->next()) {
            throw DatabaseError{};
        }
        const auto mode = rows->bytes(0);
        if (mode.size() != 3 ||
            std::string_view(reinterpret_cast<const char*>(mode.data()), mode.size()) != "wal") {
            throw DatabaseError{};
        }
        rows.reset();
        script("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
        auto synchronous = query("PRAGMA synchronous", {});
        auto foreign_keys = query("PRAGMA foreign_keys", {});
        if (!synchronous->next() || synchronous->integer(0) != 2 || !foreign_keys->next() ||
            foreign_keys->integer(0) != 1) {
            throw DatabaseError{};
        }
    }

    void begin(TransactionMode mode) override {
        script(mode == TransactionMode::Read ? "BEGIN" : "BEGIN IMMEDIATE");
    }

    void script(const char* sql) override {
        check(sqlite3_exec(db_.get(), sql, nullptr, nullptr, nullptr));
    }

    void rollback() noexcept override {
        sqlite3_exec(db_.get(), "ROLLBACK", nullptr, nullptr, nullptr);
    }

    std::unique_ptr<Rows> query(const char* sql,
                                std::initializer_list<Parameter> parameters) override {
        return std::make_unique<SqliteRows>(lease(sql), parameters);
    }

  private:
    std::unique_ptr<sqlite3_stmt, Finalize> prepare(const char* sql, unsigned int flags) {
        sqlite3_stmt* stmt = nullptr;
        const auto rc = sqlite3_prepare_v3(db_.get(), sql, -1, flags, &stmt, nullptr);
        std::unique_ptr<sqlite3_stmt, Finalize> owner(stmt);
        check(rc);
        return owner;
    }

    StatementLease lease(const char* sql) {
        constexpr std::size_t kMaxStatements = 32;
        const auto existing = statements_.find(std::string_view(sql));
        if (existing != statements_.end()) {
            auto& statement = existing->second;
            if (!statement.in_use) {
                statement.in_use = true;
                return StatementLease(statement.stmt.get(), Release{&statement});
            }
        } else if (statements_.size() < kMaxStatements) {
            const auto entry =
                statements_
                    .emplace(std::string(sql),
                             Statement{prepare(sql, SQLITE_PREPARE_PERSISTENT), true})
                    .first;
            return StatementLease(entry->second.stmt.get(), Release{&entry->second});
        }
        return StatementLease(prepare(sql, 0).release());
    }

    std::unique_ptr<sqlite3, Close> db_;
    // All Rows are scoped to one call on this serialized connection.
    std::unordered_map<std::string, Statement, SqlHash, std::equal_to<>> statements_;
};

} // namespace

std::unique_ptr<Database> connect_sqlite(const std::filesystem::path& file, bool create) {
    if (sqlite3_libversion_number() < 3037000) {
        throw DatabaseError{};
    }
    const auto path = file.u8string();
    sqlite3* raw = nullptr;
    const auto flags = SQLITE_OPEN_READWRITE | (create ? SQLITE_OPEN_CREATE : 0);
    const auto rc =
        sqlite3_open_v2(reinterpret_cast<const char*>(path.c_str()), &raw, flags, nullptr);
    std::unique_ptr<sqlite3, Close> db(raw);
    check(rc);
    return std::make_unique<SqliteDatabase>(std::move(db));
}

} // namespace lim::storage_detail
