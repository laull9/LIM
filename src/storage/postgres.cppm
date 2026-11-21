module;
#include <bit>
#include <cstddef>
#include <cstdint>
#include <initializer_list>
#include <libpq-fe.h>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

module lim.storage;
import :database;

namespace lim::storage_detail {
namespace {

struct Close {
    void operator()(PGconn* db) const noexcept { PQfinish(db); }
};

struct Clear {
    void operator()(PGresult* result) const noexcept { PQclear(result); }
};

using QueryResult = std::unique_ptr<PGresult, Clear>;

void check(const QueryResult& result) {
    if (result) {
        const auto status = PQresultStatus(result.get());
        if (status == PGRES_TUPLES_OK || status == PGRES_COMMAND_OK) {
            return;
        }
        if (const char* state = PQresultErrorField(result.get(), PG_DIAG_SQLSTATE)) {
            const std::string_view code(state);
            throw DatabaseError{code == "55P03" || code == "40P01" || code == "40001"};
        }
    }
    throw DatabaseError{};
}

class PostgresRows final : public Rows {
  public:
    explicit PostgresRows(QueryResult result) : result_(std::move(result)) {}

    bool next() override { return ++row_ < PQntuples(result_.get()); }

    std::int64_t integer(int column) const override {
        const auto encoded = bytes(column);
        if (encoded.size() != sizeof(std::int64_t)) {
            throw DatabaseError{};
        }
        std::uint64_t value = 0;
        for (const auto octet : encoded) {
            value = (value << 8) | std::to_integer<std::uint64_t>(octet);
        }
        return std::bit_cast<std::int64_t>(value);
    }

    Bytes bytes(int column) const override {
        if (PQgetisnull(result_.get(), row_, column)) {
            return {};
        }
        const auto* contents = PQgetvalue(result_.get(), row_, column);
        const auto size = PQgetlength(result_.get(), row_, column);
        return {reinterpret_cast<const std::byte*>(contents), static_cast<std::size_t>(size)};
    }

    std::string_view text(int column) const override {
        const auto value = bytes(column);
        return value.empty() ? std::string_view{}
                             : std::string_view(reinterpret_cast<const char*>(value.data()),
                                                value.size());
    }

  private:
    QueryResult result_;
    int row_ = -1;
};

class PostgresDatabase final : public Database {
  public:
    explicit PostgresDatabase(std::unique_ptr<PGconn, Close> db) : db_(std::move(db)) {}

    bool is_postgres() const override { return true; }

    void configure() override {
        script("SET search_path TO public; SET synchronous_commit TO on; "
               "SET lock_timeout TO '2s'; SET statement_timeout TO '5s'; "
               "SET client_min_messages TO warning");
    }

    void begin(TransactionMode mode) override {
        if (mode == TransactionMode::Read) {
            script("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        } else {
            script("BEGIN ISOLATION LEVEL READ COMMITTED");
        }
    }

    void script(const char* sql) override {
        const QueryResult result(PQexec(db_.get(), sql));
        check(result);
    }

    void rollback() noexcept override { PQclear(PQexec(db_.get(), "ROLLBACK")); }

    std::unique_ptr<Rows> query(const char* sql,
                                std::initializer_list<Parameter> parameters) override {
        std::vector<std::string> numbers(parameters.size());
        std::vector<const char*> values;
        std::vector<int> lengths;
        std::vector<int> formats;
        for (std::size_t index = 0; const auto& parameter : parameters) {
            if (const auto* number = std::get_if<std::int64_t>(&parameter)) {
                numbers[index] = std::to_string(*number);
                values.push_back(numbers[index].c_str());
                lengths.push_back(0);
                formats.push_back(0);
            } else if (const auto* text = std::get_if<std::string_view>(&parameter)) {
                values.push_back(text->data());
                lengths.push_back(static_cast<int>(text->size()));
                formats.push_back(0);
            } else {
                const auto bytes = std::get<Bytes>(parameter);
                values.push_back(reinterpret_cast<const char*>(bytes.data()));
                lengths.push_back(static_cast<int>(bytes.size()));
                formats.push_back(1);
            }
            ++index;
        }
        QueryResult result(PQexecParams(db_.get(), sql, static_cast<int>(parameters.size()),
                                        nullptr, values.data(), lengths.data(), formats.data(), 1));
        check(result);
        return std::make_unique<PostgresRows>(std::move(result));
    }

  private:
    std::unique_ptr<PGconn, Close> db_;
};

} // namespace

std::unique_ptr<Database> connect_postgres(const std::string& connection_info) {
    const char* const keywords[] = {"connect_timeout", "dbname", nullptr};
    const char* const values[] = {"5", connection_info.c_str(), nullptr};
    std::unique_ptr<PGconn, Close> db(PQconnectdbParams(keywords, values, 1));
    if (!db || PQstatus(db.get()) != CONNECTION_OK || PQserverVersion(db.get()) < 140000) {
        throw DatabaseError{};
    }
    return std::make_unique<PostgresDatabase>(std::move(db));
}

} // namespace lim::storage_detail
