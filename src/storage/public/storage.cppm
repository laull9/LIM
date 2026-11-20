module;
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

export module lim.storage;
export import lim.chat;

export namespace lim {

struct SqliteOptions {
    std::filesystem::path file;
};

struct PostgresOptions {
    std::string connection_info;
};

using StorageOptions = std::variant<SqliteOptions, PostgresOptions>;

enum class StorageOpenError {
    InvalidConfiguration,
    ConnectionFailed,
    InitializationFailed,
    UnsupportedSchema,
    GenerationMismatch,
    RecoveryDeviceMismatch,
    RecoveryCredentialReuse
};

struct StorageRecovery {
    Id snapshot_generation;
    Id new_generation;
    std::span<const Session> reviewed_devices;
};

struct ConversationSummary {
    Id id;
    Sequence after;
    Sequence last_seq;
};

struct ConversationPage {
    std::vector<ConversationSummary> conversations;
    std::optional<Id> next_after;
};

// Host administration is trusted. Session.credential is an opaque credential ID
// supplied by an authenticated adapter. It is never an access token or password.
class Store : public Chat {
  public:
    [[nodiscard]] virtual Result<void> register_device(const Session& session) = 0;
    [[nodiscard]] virtual Result<void> revoke_device(Id device) = 0;
    [[nodiscard]] virtual Result<void> create_host_conversation(Id conversation) = 0;
    [[nodiscard]] virtual Result<void> set_member(Id conversation, Id device, bool active) = 0;
    [[nodiscard]] virtual Result<void> expire_through(Id conversation, Sequence through) = 0;
    [[nodiscard]] virtual Result<void> check_generation(Id generation) = 0;
    [[nodiscard]] virtual Result<void> check_session(const Session& session) = 0;
    [[nodiscard]] virtual Result<ConversationPage> list_conversations(const Session& session,
                                                                      std::optional<Id> after) = 0;
    [[nodiscard]] virtual Result<ConversationSummary> conversation_summary(const Session& session,
                                                                           Id conversation) = 0;
};

// Opens a file or a dedicated PostgreSQL database. Initializes an empty store with
// the supplied generation; an existing store must match it. The owner serializes
// calls on a handle; separate handles coordinate through database transactions.
[[nodiscard]] std::expected<std::unique_ptr<Store>, StorageOpenError>
open_store(const StorageOptions& options, Id generation);

// Operates on an existing, restored database with all other LIM handles closed.
// Reviewed devices must be active in the snapshot and use fresh credential IDs.
// Their snapshot memberships are retained. All other devices lose access.
[[nodiscard]] std::expected<void, StorageOpenError> recover_store(const StorageOptions& options,
                                                                  const StorageRecovery& recovery);

} // namespace lim
