module;
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

#include <LJson.hpp>
#include <LString.hpp>

export module lim.server.rpc;
import lim.server.config;
import lim.server.contract;
import lim.storage;

export namespace lim::server {

inline constexpr std::size_t kRpcRequestBytes = 512 * 1024;

[[nodiscard]] std::optional<std::string> handle_rpc(Store& store, const Config& config,
                                                    std::string_view token, std::string_view body,
                                                    std::atomic<std::uint64_t>& revision);

} // namespace lim::server

namespace lim::server {
namespace {

constexpr std::size_t kBatchLimit = 16;
constexpr std::size_t kRpcResponseBytes = 2 * 1024 * 1024;
constexpr std::size_t kEnvelopeBytes = 1024;
// Fixed keys, two UUIDs, the sequence and the content type fit this allowance.
constexpr std::size_t kEventMetadataBytes = 256;
constexpr std::size_t kMaxEncodedPayload = 4 * ((kMessageBytes + 2) / 3);

static_assert((kRpcResponseBytes - kRpcRequestBytes) / kBatchLimit >
              kMaxEncodedPayload + kEnvelopeBytes * 2);

struct InvalidParams {};

Json field(const Json& params, const char* key) {
    if (!params.contains(key)) {
        throw InvalidParams{};
    }
    return params[key];
}

std::string text_field(const Json& params, const char* key) {
    const auto value = field(params, key);
    if (!value.is_string()) {
        throw InvalidParams{};
    }
    return value.as_string();
}

Id id_field(const Json& params, const char* key) {
    if (const auto id = parse_id(text_field(params, key)); id && *id != Id{}) {
        return *id;
    }
    throw InvalidParams{};
}

Sequence sequence_field(const Json& params, const char* key) {
    if (const auto result = parse_sequence(text_field(params, key))) {
        return *result;
    }
    throw InvalidParams{};
}

std::string encode_base64(std::span<const std::byte> bytes) {
    return LString::base64_encode(
        std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
}

std::span<const std::byte> byte_view(std::string_view text) {
    return std::as_bytes(std::span(text.data(), text.size()));
}

std::string decode_base64(std::string_view encoded) {
    if (encoded.empty() || encoded.size() > kMaxEncodedPayload || encoded.size() % 4 != 0) {
        throw InvalidParams{};
    }
    std::string bytes;
    try {
        bytes = LString::base64_decode(encoded);
    } catch (const std::invalid_argument&) {
        throw InvalidParams{};
    }
    if (bytes.empty() || bytes.size() > kMessageBytes ||
        encode_base64(byte_view(bytes)) != encoded) {
        throw InvalidParams{};
    }
    return bytes;
}

struct RpcError {
    int code;
    std::string_view message;
    Json data = nullptr;
};

RpcError from_failure(const Failure& failure) {
    const auto detail = failure_info(failure.code);
    auto data = Json::object();
    data["name"] = std::string(detail.name);
    data["retryable"] = detail.retryable;
    if (failure.sequence) {
        data["sequence"] = std::to_string(*failure.sequence);
    }
    return {detail.rpc, detail.rpc == -32602 ? "Invalid params" : detail.name, std::move(data)};
}

template <typename T> void require(const Result<T>& result) {
    if (!result) {
        throw from_failure(result.error());
    }
}

Json accepted() {
    auto result = Json::object();
    result["ok"] = true;
    return result;
}

const Session& device_session(const Principal& principal, const Json& params) {
    if (!principal.session) {
        throw RpcError{-32001, "Device authentication required"};
    }
    auto& session = *principal.session;
    const auto supplied = id_field(params, "generation");
    if (supplied != session.generation) {
        throw from_failure(Failure{Error::RecoveryRequired, std::nullopt});
    }
    return session;
}

void require_operator(const Principal& principal) {
    if (!principal.is_operator) {
        throw RpcError{-32003, "Operator authorization required"};
    }
}

Json send_message(Store& store, const Principal& principal, const Json& params,
                  std::atomic<std::uint64_t>& revision) {
    const auto& session = device_session(principal, params);
    const auto conversation = id_field(params, "conversation_id");
    const auto key = id_field(params, "client_message_id");
    const auto type = text_field(params, "content_type");
    std::string payload;
    HostContent format = HostContent::Text;
    if (type == "application/octet-stream" && !params.contains("text")) {
        format = HostContent::Binary;
        payload = decode_base64(text_field(params, "payload_base64"));
    } else if ((type == "text/plain" || type == "application/json") &&
               !params.contains("payload_base64")) {
        payload = text_field(params, "text");
        if (type == "application/json") {
            format = HostContent::Json;
            if (payload.size() <= kMessageBytes && !parse_json(payload)) {
                throw InvalidParams{};
            }
        }
    } else {
        throw InvalidParams{};
    }
    const auto result = store.append(session, {conversation, key, format, byte_view(payload)});
    require(result);
    if (!result->replayed) {
        revision.fetch_add(1);
    }
    auto reply = Json::object();
    reply["seq"] = std::to_string(result->seq);
    reply["replayed"] = result->replayed;
    return reply;
}

Json read_events(Store& store, const Principal& principal, const Json& params, std::size_t budget) {
    const auto& session = device_session(principal, params);
    const auto conversation = id_field(params, "conversation_id");
    const auto after = sequence_field(params, "after");
    const auto up_to =
        params.contains("up_to") ? std::optional(sequence_field(params, "up_to")) : std::nullopt;
    const auto page = store.read(session, {conversation, after, up_to});
    require(page);
    Json events = Json::array();
    Sequence next = after;
    for (const auto& event : page->events) {
        const auto bytes = 4 * ((event.payload.size() + 2) / 3) + kEventMetadataBytes;
        if (bytes > budget) {
            break;
        }
        budget -= bytes;
        auto item = Json::object();
        item["seq"] = std::to_string(event.seq);
        item["device_id"] = encode_id(event.sender_device);
        item["client_message_id"] = encode_id(event.client_message_id);
        const auto type = content_type(event.format);
        if (type.empty()) {
            throw RpcError{-32603, "Internal error"};
        }
        item["content_type"] = std::string(type);
        item["payload_base64"] = encode_base64(event.payload);
        events.push_back(std::move(item));
        next = event.seq;
    }
    auto result = Json::object();
    result["up_to"] = std::to_string(page->up_to);
    result["next_after"] = std::to_string(next);
    result["events"] = std::move(events);
    return result;
}

Json list_conversations(Store& store, const Principal& principal, const Json& params) {
    const auto& session = device_session(principal, params);
    const auto cursor =
        params.contains("after") ? std::optional(id_field(params, "after")) : std::nullopt;
    const auto page = store.list_conversations(session, cursor);
    require(page);
    Json entries = Json::array();
    for (const auto& item : page->conversations) {
        auto entry = Json::object();
        entry["conversation_id"] = encode_id(item.id);
        entry["after"] = std::to_string(item.after);
        entry["last_seq"] = std::to_string(item.last_seq);
        entry["profile"] = "host";
        entries.push_back(std::move(entry));
    }
    auto result = Json::object();
    result["conversations"] = std::move(entries);
    result["next_after"] = nullptr;
    if (page->next_after) {
        result["next_after"] = encode_id(*page->next_after);
    }
    return result;
}

Json dispatch(Store& store, const Config& config, const Principal& principal,
              std::string_view method, const Json& params, std::size_t budget,
              std::atomic<std::uint64_t>& revision) {
    if (!params.is_object()) {
        throw InvalidParams{};
    }
    if (method == "session.info") {
        if (!principal.session) {
            throw RpcError{-32001, "Device authentication required"};
        }
        const auto& session = *principal.session;
        require(store.check_session(session));
        auto result = Json::object();
        result["generation"] = encode_id(session.generation);
        result["account"] = encode_id(session.account);
        result["device"] = encode_id(session.device);
        return result;
    }
    if (method == "conversation.list") {
        return list_conversations(store, principal, params);
    }
    if (method == "message.send") {
        return send_message(store, principal, params, revision);
    }
    if (method == "conversation.events") {
        return read_events(store, principal, params, budget);
    }
    if (method != "conversation.create" && method != "conversation.set_member" &&
        method != "conversation.expire" && method != "device.revoke") {
        throw RpcError{-32601, "Method not found"};
    }
    require_operator(principal);
    if (id_field(params, "generation") != config.generation) {
        throw from_failure(Failure{Error::RecoveryRequired, std::nullopt});
    }
    if (method == "device.revoke") {
        require(store.revoke_device(id_field(params, "device_id")));
        revision.fetch_add(1);
        return accepted();
    }
    const auto conversation = id_field(params, "conversation_id");
    if (method == "conversation.create") {
        if (text_field(params, "profile") != "host") {
            throw from_failure(Failure{Error::ProfileMismatch, std::nullopt});
        }
        require(store.create_host_conversation(conversation));
    } else if (method == "conversation.set_member") {
        const auto& active = field(params, "active");
        if (!active.is_boolean()) {
            throw InvalidParams{};
        }
        require(store.set_member(conversation, id_field(params, "device_id"), active.as_bool()));
    } else {
        require(store.expire_through(conversation, sequence_field(params, "through")));
    }
    revision.fetch_add(1);
    return accepted();
}

Json envelope(const Json& id) {
    auto result = Json::object();
    result["jsonrpc"] = "2.0";
    result["id"] = id;
    return result;
}

Json error_response(const Json& id, const RpcError& error) {
    auto detail = Json::object();
    detail["code"] = error.code;
    detail["message"] = std::string(error.message);
    if (!error.data.is_null()) {
        detail["data"] = error.data;
    }
    auto result = envelope(id);
    result["error"] = std::move(detail);
    return result;
}

Json handle_request(Store& store, const Config& config, const Principal& principal,
                    const Json& request, std::size_t budget, std::atomic<std::uint64_t>& revision) {
    if (!request.is_object()) {
        return error_response(nullptr, {-32600, "Invalid Request"});
    }
    const bool notification = !request.contains("id");
    const Json id = notification ? Json(nullptr) : request["id"];
    const bool valid_id = id.is_null() || id.is_number() || id.is_string();
    const bool valid_version = request.contains("jsonrpc") && request["jsonrpc"] == "2.0";
    const auto method = request.contains("method") ? request["method"] : Json(nullptr);
    if (!valid_id || !valid_version || !method.is_string()) {
        return error_response(valid_id ? id : Json(nullptr), {-32600, "Invalid Request"});
    }

    const auto invoke = [&]() -> Json {
        return dispatch(store, config, principal, method.as_string(),
                        request.contains("params") ? request["params"] : Json::object(), budget,
                        revision);
    };
    try {
        auto result = invoke();
        if (!notification) {
            auto response = envelope(id);
            response["result"] = std::move(result);
            return response;
        }
    } catch (const InvalidParams&) {
        if (!notification) {
            return error_response(id, {-32602, "Invalid params"});
        }
    } catch (const RpcError& error) {
        if (!notification) {
            return error_response(id, error);
        }
    } catch (const std::exception&) {
        if (!notification) {
            return error_response(id, {-32603, "Internal error"});
        }
    }
    return nullptr;
}

} // namespace

std::optional<std::string> handle_rpc(Store& store, const Config& config, std::string_view token,
                                      std::string_view body, std::atomic<std::uint64_t>& revision) {
    const auto request = parse_json(body);
    if (!request) {
        return error_response(nullptr, {-32700, "Parse error"}).dump();
    }
    const auto principal = authenticate(config, token);
    if (!request->is_array()) {
        const auto response =
            handle_request(store, config, principal, *request,
                           kRpcResponseBytes - kRpcRequestBytes - kEnvelopeBytes, revision);
        return response.is_null() ? std::nullopt : std::optional(response.dump());
    }
    if (request->json_size() == 0) {
        return error_response(nullptr, {-32600, "Invalid Request"}).dump();
    }
    if (request->json_size() > kBatchLimit) {
        return error_response(nullptr, {-32013, "Batch limit exceeded"}).dump();
    }
    const auto budget =
        (kRpcResponseBytes - kRpcRequestBytes) / request->json_size() - kEnvelopeBytes;
    Json responses = Json::array();
    const auto& batch = *request;
    for (std::size_t index = 0; index < batch.json_size(); ++index) {
        auto response = handle_request(store, config, principal, batch[index], budget, revision);
        if (!response.is_null()) {
            responses.push_back(std::move(response));
        }
    }
    return responses.json_size() == 0 ? std::nullopt : std::optional(responses.dump());
}

} // namespace lim::server
