module;
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include <LJson.hpp>
#include <LString.hpp>

export module lim.server.binary;
import lim.frame;
import lim.server.config;
import lim.server.contract;
import lim.storage;

export namespace lim::server {

inline constexpr std::string_view kRecordType = "application/vnd.lim.record";
inline constexpr std::string_view kEventsType = "application/vnd.lim.events";

struct WireReply {
    int status;
    std::string body;
    std::string_view type = "application/json";
    std::optional<Sequence> up_to = std::nullopt;
};

[[nodiscard]] WireReply wire_error(Failure failure, std::string_view request_id = {});
[[nodiscard]] WireReply append_record(Store& store, const Config& config, std::string_view token,
                                      Id conversation, std::string_view body,
                                      std::atomic<std::uint64_t>& revision);
[[nodiscard]] WireReply read_records(Store& store, const Config& config, std::string_view token,
                                     Id generation, const Read& query);
[[nodiscard]] std::optional<WireReply> wait_for_events(Store& store, const Config& config,
                                                       std::string_view token, Id generation,
                                                       Id conversation, Sequence after,
                                                       bool final_check);

} // namespace lim::server

namespace lim::server {
namespace {

WireReply error(Error code, std::string_view request_id = {}) {
    return wire_error(Failure{code, std::nullopt}, request_id);
}

Result<Session> session_for(Store& store, const Config& config, std::string_view token,
                            Id generation) {
    const auto principal = authenticate(store, config, token);
    if (!principal.session) {
        return std::unexpected(Failure{Error::Unauthenticated, std::nullopt});
    }
    if (principal.session->generation != generation) {
        return std::unexpected(Failure{Error::RecoveryRequired, std::nullopt});
    }
    return *principal.session;
}

std::string get_text(const Json& header, const char* key) {
    if (header.contains(key)) {
        const auto field = header[key];
        if (field.is_string()) {
            return field.as_string();
        }
    }
    return {};
}

std::string_view text_view(std::span<const std::byte> value) {
    if (value.empty()) {
        return {};
    }
    return {reinterpret_cast<const char*>(value.data()), value.size()};
}

void append_size(std::string& out, std::uint32_t size) {
    for (unsigned int shift : {24u, 16u, 8u, 0u}) {
        out.push_back(static_cast<char>((size >> shift) & 0xff));
    }
}

Json event_header(const Event& event, Id conversation, Id generation) {
    auto header = Json::object();
    header["v"] = 1;
    header["type"] = "event.message";
    header["recovery_generation"] = encode_id(generation);
    header["conversation_id"] = encode_id(conversation);
    header["conversation_seq"] = std::to_string(event.seq);
    header["device_id"] = encode_id(event.sender_device);
    header["account_id"] = encode_id(event.sender_account);
    header["client_message_id"] = encode_id(event.client_message_id);
    header["profile"] = "host";
    header["content_type"] = std::string(content_type(event.format));
    return header;
}

} // namespace

WireReply wire_error(Failure failure, std::string_view request_id) {
    const auto info = failure_info(failure.code);
    auto body = Json::object();
    body["code"] = std::string(info.name);
    body["request_id"] = std::string(request_id);
    body["retryable"] = info.retryable;
    if (failure.sequence) {
        body["sequence"] = std::to_string(*failure.sequence);
    }
    return {info.http, body.dump()};
}

WireReply append_record(Store& store, const Config& config, std::string_view token, Id conversation,
                        std::string_view body, std::atomic<std::uint64_t>& revision) {
    const auto bytes = std::as_bytes(std::span(body.data(), body.size()));
    const auto frame = wire::split_frame(bytes, wire::PayloadClass::Message);
    if (!frame) {
        return error(frame.error() == wire::FrameError::PayloadTooLarge ||
                             frame.error() == wire::FrameError::HeaderTooLarge
                         ? Error::PayloadTooLarge
                         : Error::InvalidArgument);
    }
    const auto header = parse_json(text_view(frame->header));
    if (!header || !header->is_object()) {
        return error(Error::InvalidArgument);
    }
    const auto request_id = get_text(*header, "request_id");
    if (request_id.empty() || request_id.size() > 128) {
        return error(Error::InvalidArgument);
    }
    const auto generation = parse_id(get_text(*header, "recovery_generation"));
    const auto room = parse_id(get_text(*header, "conversation_id"));
    const auto key = parse_id(get_text(*header, "client_message_id"));
    if (!header->contains("v") || (*header)["v"] != 1 ||
        get_text(*header, "type") != "message.send" || !generation || room != conversation ||
        !key || *key == Id{}) {
        return error(Error::InvalidArgument, request_id);
    }
    const auto session = session_for(store, config, token, *generation);
    if (!session) {
        return wire_error(session.error(), request_id);
    }
    const auto wrong_sender = [&](const char* field) {
        return header->contains(field) && parse_id(get_text(*header, field)) != session->device;
    };
    if (wrong_sender("sender") || wrong_sender("device_id")) {
        return error(Error::InvalidArgument, request_id);
    }
    if (get_text(*header, "profile") != "host") {
        return error(Error::ProfileMismatch, request_id);
    }
    const auto type = host_content(get_text(*header, "content_type"));
    const auto payload = text_view(frame->payload);
    if (!type || payload.empty() || (*type == HostContent::Text && !LString::valid_utf8(payload)) ||
        (*type == HostContent::Json && !parse_json(payload)) ||
        header->contains("group_instance_id") || header->contains("epoch")) {
        return error(Error::InvalidArgument, request_id);
    }
    const auto receipt = store.append(*session, {conversation, *key, *type, frame->payload});
    if (!receipt) {
        return wire_error(receipt.error(), request_id);
    }
    if (!receipt->replayed) {
        revision.fetch_add(1);
    }
    auto reply = Json::object();
    reply["v"] = 1;
    reply["type"] = "message.accepted";
    reply["request_id"] = request_id;
    reply["recovery_generation"] = encode_id(session->generation);
    reply["conversation_id"] = encode_id(conversation);
    reply["conversation_seq"] = std::to_string(receipt->seq);
    reply["replayed"] = receipt->replayed;
    return {200, reply.dump()};
}

WireReply read_records(Store& store, const Config& config, std::string_view token, Id generation,
                       const Read& query) {
    const auto session = session_for(store, config, token, generation);
    if (!session) {
        return wire_error(session.error());
    }
    const auto page = store.read(*session, query);
    if (!page) {
        return wire_error(page.error());
    }
    std::size_t payload_bytes = 0;
    for (const auto& event : page->events) {
        payload_bytes += event.payload.size();
    }
    std::string body;
    body.reserve(payload_bytes + page->events.size() * 400);
    for (const auto& event : page->events) {
        if (event.kind != EventKind::Message || content_type(event.format).empty()) {
            return {500, R"({"code":"internal_error","request_id":"","retryable":false})"};
        }
        const auto header = event_header(event, query.conversation, generation).dump();
        append_size(body, static_cast<std::uint32_t>(4 + header.size() + event.payload.size()));
        append_size(body, static_cast<std::uint32_t>(header.size()));
        body.append(header);
        body.append(text_view(event.payload));
    }
    return {200, std::move(body), kEventsType, page->up_to};
}

std::optional<WireReply> wait_for_events(Store& store, const Config& config, std::string_view token,
                                         Id generation, Id conversation, Sequence after,
                                         bool final_check) {
    const auto session = session_for(store, config, token, generation);
    if (!session) {
        return wire_error(session.error());
    }
    const auto summary = store.conversation_summary(*session, conversation);
    if (!summary) {
        return wire_error(summary.error());
    }
    if (after > summary->last_seq) {
        return error(Error::InvalidArgument);
    }
    if (after < summary->after) {
        return wire_error(Failure{Error::CursorExpired, summary->after});
    }
    if (after == summary->last_seq) {
        if (final_check) {
            return WireReply{204, {}, {}, after};
        }
        return std::nullopt;
    }
    auto hint = Json::object();
    hint["v"] = 1;
    hint["type"] = "sync.hint";
    hint["conversation_id"] = encode_id(conversation);
    hint["recovery_generation"] = encode_id(generation);
    hint["up_to"] = std::to_string(summary->last_seq);
    return WireReply{200, hint.dump(), "application/json", summary->last_seq};
}

} // namespace lim::server
