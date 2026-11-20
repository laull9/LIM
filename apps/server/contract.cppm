module;
#include <charconv>
#include <optional>
#include <string_view>
#include <system_error>
#include <variant>

export module lim.server.contract;
import lim.storage;

export namespace lim::server {

struct FailureInfo {
    int rpc;
    int http;
    std::string_view name;
    bool retryable = false;
};

[[nodiscard]] FailureInfo failure_info(Error code);
[[nodiscard]] std::optional<Sequence> parse_sequence(std::string_view text);
[[nodiscard]] std::optional<HostContent> host_content(std::string_view type);
[[nodiscard]] std::string_view content_type(const MessageFormat& format);

} // namespace lim::server

namespace lim::server {

FailureInfo failure_info(Error code) {
    using enum Error;
    switch (code) {
    case Unauthenticated:
        return {-32001, 401, "unauthenticated"};
    case DeviceRevoked:
        return {-32001, 401, "device_revoked"};
    case NotFoundOrForbidden:
        return {-32004, 404, "not_found_or_forbidden"};
    case InvalidArgument:
        return {-32602, 400, "invalid_argument"};
    case PayloadTooLarge:
        return {-32013, 413, "payload_too_large"};
    case ProfileMismatch:
        return {-32009, 409, "profile_mismatch"};
    case IdempotencyConflict:
        return {-32009, 409, "idempotency_conflict"};
    case IdempotencyExpired:
        return {-32009, 409, "idempotency_expired"};
    case EpochConflict:
        return {-32009, 409, "epoch_conflict"};
    case RekeyRequired:
        return {-32009, 409, "rekey_required"};
    case RecoveryRequired:
        return {-32009, 409, "recovery_required"};
    case CursorExpired:
        return {-32010, 410, "cursor_expired"};
    case Overloaded:
        return {-32029, 503, "overloaded", true};
    case TemporarilyUnavailable:
        return {-32053, 503, "temporarily_unavailable", true};
    }
    return {-32603, 500, "internal_error"};
}

std::optional<Sequence> parse_sequence(std::string_view text) {
    if (text.empty() || (text.front() == '0' && text.size() > 1) || text.front() < '0' ||
        text.front() > '9') {
        return std::nullopt;
    }
    Sequence result = 0;
    const auto* end = text.data() + text.size();
    const auto [next, error] = std::from_chars(text.data(), end, result);
    if (error != std::errc{} || next != end) {
        return std::nullopt;
    }
    return result;
}

std::optional<HostContent> host_content(std::string_view type) {
    if (type == "text/plain") {
        return HostContent::Text;
    }
    if (type == "application/json") {
        return HostContent::Json;
    }
    if (type == "application/octet-stream") {
        return HostContent::Binary;
    }
    return std::nullopt;
}

std::string_view content_type(const MessageFormat& format) {
    if (const auto* host = std::get_if<HostContent>(&format)) {
        switch (*host) {
        case HostContent::Text:
            return "text/plain";
        case HostContent::Json:
            return "application/json";
        case HostContent::Binary:
            return "application/octet-stream";
        }
    }
    return {};
}

} // namespace lim::server
