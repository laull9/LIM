module;
#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <span>
#include <variant>
#include <vector>

export module lim.chat;

export namespace lim {

struct Id {
    std::array<std::byte, 16> bytes{};
    bool operator==(const Id&) const = default;
};

using Sequence = std::int64_t;

inline constexpr std::size_t kMessageBytes = 64 * 1024;
inline constexpr std::size_t kControlBytes = 1024 * 1024;
inline constexpr std::size_t kHeaderBytes = 4 * 1024;
inline constexpr std::size_t kPageBytes = 2 * 1024 * 1024;
inline constexpr std::size_t kPageEvents = 100;

struct Session {
    Id account;
    Id device;
    Id generation;
    Id credential;
};

struct MlsMessage {
    Id group_instance;
    Sequence epoch;
    bool operator==(const MlsMessage&) const = default;
};

enum class HostContent { Text, Json, Binary };
using MessageFormat = std::variant<MlsMessage, HostContent>;

struct Append {
    Id conversation;
    Id client_message_id;
    MessageFormat format;
    std::span<const std::byte> payload;
};

struct Receipt {
    Sequence seq;
    bool replayed;
};

struct Read {
    Id conversation;
    Sequence after;
    std::optional<Sequence> up_to;
};

enum class EventKind { Message, MlsCommit };

struct Event {
    Sequence seq;
    Id sender_device;
    Id client_message_id;
    EventKind kind;
    MessageFormat format;
    std::vector<std::byte> payload;
};

struct Page {
    Sequence up_to;
    std::vector<Event> events;
};

enum class Error {
    Unauthenticated,
    DeviceRevoked,
    NotFoundOrForbidden,
    InvalidArgument,
    PayloadTooLarge,
    ProfileMismatch,
    IdempotencyConflict,
    IdempotencyExpired,
    EpochConflict,
    RekeyRequired,
    CursorExpired,
    RecoveryRequired,
    Overloaded,
    TemporarilyUnavailable
};

struct Failure {
    Error code;
    // Original sequence for expired idempotency keys or floor for expired cursors.
    std::optional<Sequence> sequence;
};

template <typename T> using Result = std::expected<T, Failure>;

// Trusted adapters supply the authenticated session. Implementations must recheck
// authorization inside the transaction. Calls on one handle are serialized by its owner.
// Borrowed input lives through the call; receipts and pages belong to the caller.
class Chat {
  public:
    virtual ~Chat() = default;
    [[nodiscard]] virtual Result<Receipt> append(const Session& session, const Append& cmd) = 0;
    [[nodiscard]] virtual Result<Page> read(const Session& session, const Read& query) = 0;
};

} // namespace lim
