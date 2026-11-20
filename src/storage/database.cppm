module;
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <initializer_list>
#include <memory>
#include <span>
#include <string>
#include <variant>

module lim.storage:database;

namespace lim::storage_detail {

using Bytes = std::span<const std::byte>;
using Parameter = std::variant<std::int64_t, Bytes>;

struct DatabaseError {
    bool busy = false;
};

class Rows {
  public:
    virtual ~Rows() = default;
    virtual bool next() = 0;
    virtual std::int64_t integer(int column) const = 0;
    // The view is valid until the row advances or is destroyed. NULL gives an empty view.
    virtual Bytes bytes(int column) const = 0;
};

enum class TransactionMode { Read, Write, Migration };

class Database {
  public:
    virtual ~Database() = default;
    virtual bool is_postgres() const = 0;
    virtual void configure() = 0;
    virtual void begin(TransactionMode mode) = 0;
    virtual void script(const char* sql) = 0;
    virtual void rollback() noexcept = 0;
    virtual std::unique_ptr<Rows> query(const char* sql,
                                        std::initializer_list<Parameter> parameters) = 0;

    void exec(const char* sql, std::initializer_list<Parameter> parameters = {}) {
        auto rows = query(sql, parameters);
        while (rows->next()) {
        }
    }
};

std::unique_ptr<Database> connect_sqlite(const std::filesystem::path& file, bool create);
std::unique_ptr<Database> connect_postgres(const std::string& connection_info);

} // namespace lim::storage_detail
