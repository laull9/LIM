module;
#include <array>
#include <expected>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
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
using SecretDigest = std::array<std::byte, 32>;

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

struct AccountProfile {
    Id id;
    std::string username;
    std::string display_name;
};

struct StoredAccount {
    Id id;
    std::string username;
    std::string display_name;
    std::string password_hash;
};

struct AuthContext {
    Session session;
    Id login;
    std::string username;
    std::string display_name;
    Sequence access_expires;
    Sequence refresh_expires;
};

struct DeviceSummary {
    Id id;
    std::string name;
    Sequence created_at;
    Sequence last_seen;
    bool revoked;
};

struct ConversationSummary {
    Id id;
    Sequence after;
    Sequence last_seq;
    std::string kind = "host";
    std::string title;
    std::vector<AccountProfile> members;
    bool account_scoped = false;
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

    [[nodiscard]] virtual Result<StoredAccount> create_account(Id id, std::string_view username,
                                                               std::string_view display_name,
                                                               std::string_view password_hash) = 0;
    [[nodiscard]] virtual Result<StoredAccount> account_by_username(std::string_view username) = 0;
    [[nodiscard]] virtual Result<AuthContext>
    create_login(Id login, Id account, Id device, std::string_view device_name, Id credential,
                 SecretDigest access_digest, SecretDigest refresh_digest, Sequence now,
                 Sequence access_expires, Sequence refresh_expires) = 0;
    [[nodiscard]] virtual Result<AuthContext>
    rotate_login(SecretDigest old_refresh, SecretDigest access_digest, SecretDigest refresh_digest,
                 Sequence now, Sequence access_expires, Sequence refresh_expires) = 0;
    [[nodiscard]] virtual Result<AuthContext> access_session(SecretDigest access_digest,
                                                             Sequence now) = 0;
    [[nodiscard]] virtual Result<void> logout(Id login, Id account) = 0;
    [[nodiscard]] virtual Result<std::vector<AccountProfile>>
    search_accounts(const Session& session, std::string_view prefix, Sequence limit) = 0;
    [[nodiscard]] virtual Result<ConversationSummary>
    start_conversation(const Session& session, Id conversation, std::span<const Id> targets,
                       std::string_view kind, std::string_view title,
                       std::string_view direct_key) = 0;
    [[nodiscard]] virtual Result<std::vector<DeviceSummary>> list_devices(const Session& session) = 0;
    [[nodiscard]] virtual Result<void> remove_device(const Session& session, Id device) = 0;
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
