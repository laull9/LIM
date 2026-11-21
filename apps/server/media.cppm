module;
#include <algorithm>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

#include <LJson.hpp>
#include <LString.hpp>

export module lim.server.media;
import lim.server.auth;
import lim.server.binary;
import lim.server.config;
import lim.server.contract;
import lim.storage;

export namespace lim::server {

struct MediaReply {
    int status = 200;
    std::string body;
    std::string type = "application/json";
    std::string content_disposition;
    std::string content_range;
    bool cacheable = false;
    bool accept_ranges = false;
};

[[nodiscard]] MediaReply upload_media_single(Store& store, const Config& config,
                                             std::string_view token, Id generation, Id conversation,
                                             std::string_view mime_type, std::string_view filename,
                                             std::string_view body);
[[nodiscard]] MediaReply init_media_upload(Store& store, const Config& config,
                                           std::string_view token, Id generation, Id conversation,
                                           std::string_view body);
[[nodiscard]] MediaReply upload_media_chunk(Store& store, const Config& config,
                                            std::string_view token, Id generation, Id conversation,
                                            Id media_id, Sequence chunk_index,
                                            std::string_view body);
[[nodiscard]] MediaReply complete_media_upload(Store& store, const Config& config,
                                               std::string_view token, Id generation,
                                               Id conversation, Id media_id, std::string_view body);
[[nodiscard]] MediaReply download_media(Store& store, const Config& config, std::string_view token,
                                        Id generation, Id conversation, Id media_id,
                                        std::string_view range_header);

} // namespace lim::server

namespace lim::server {
namespace {

MediaReply from_wire(WireReply reply) {
    return MediaReply{reply.status, std::move(reply.body), std::string(reply.type), {}, {}, false,
                      false};
}

MediaReply error_reply(Error code) {
    return from_wire(wire_error(Failure{code, std::nullopt}));
}

Result<Session> media_session(Store& store, const Config& config, std::string_view token,
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

std::string sanitize_mime(std::string_view raw) {
    while (!raw.empty() && (raw.front() == ' ' || raw.front() == '\t')) {
        raw.remove_prefix(1);
    }
    while (!raw.empty() && (raw.back() == ' ' || raw.back() == '\t')) {
        raw.remove_suffix(1);
    }
    if (raw.empty() || raw.size() > 128 || raw.find('/') == raw.npos) {
        return "application/octet-stream";
    }
    for (const char ch : raw) {
        const auto byte = static_cast<unsigned char>(ch);
        if (byte < 0x20 || byte >= 0x7f) {
            return "application/octet-stream";
        }
    }
    return std::string(raw);
}

int hex_value(char ch) {
    if (ch >= '0' && ch <= '9') {
        return ch - '0';
    }
    if (ch >= 'a' && ch <= 'f') {
        return 10 + (ch - 'a');
    }
    if (ch >= 'A' && ch <= 'F') {
        return 10 + (ch - 'A');
    }
    return -1;
}

std::string decode_percent(std::string_view input) {
    std::string out;
    out.reserve(input.size());
    for (std::size_t i = 0; i < input.size(); ++i) {
        if (input[i] == '%' && i + 2 < input.size()) {
            const int hi = hex_value(input[i + 1]);
            const int lo = hex_value(input[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        out.push_back(input[i]);
    }
    return out;
}

std::string sanitize_filename(std::string_view raw) {
    const auto decoded = decode_percent(raw);
    std::string cleaned;
    cleaned.reserve(std::min<std::size_t>(decoded.size(), 180));
    for (const char ch : decoded) {
        const auto byte = static_cast<unsigned char>(ch);
        if (byte < 0x20 || byte == 0x7f || ch == '/' || ch == '\\' || ch == '"') {
            continue;
        }
        cleaned.push_back(ch);
        if (cleaned.size() >= 180) {
            break;
        }
    }
    if (!LString::valid_utf8(cleaned)) {
        return "attachment";
    }
    return cleaned;
}

Json meta_json(const MediaMeta& meta) {
    auto doc = Json::object();
    doc["media_id"] = encode_id(meta.id);
    doc["conversation_id"] = encode_id(meta.conversation);
    doc["mime_type"] = meta.mime_type;
    doc["filename"] = meta.filename;
    doc["size"] = meta.size_bytes;
    return doc;
}

bool is_inline_safe(std::string_view mime) {
    return mime.starts_with("image/") || mime.starts_with("audio/") || mime.starts_with("video/");
}

struct ByteRange {
    std::size_t start;
    std::size_t end;
};

std::optional<ByteRange> parse_range(std::string_view header, std::size_t total) {
    constexpr std::string_view prefix = "bytes=";
    if (total == 0 || !header.starts_with(prefix)) {
        return std::nullopt;
    }
    const auto spec = header.substr(prefix.size());
    if (spec.find(',') != spec.npos) {
        return std::nullopt;
    }
    const auto dash = spec.find('-');
    if (dash == spec.npos) {
        return std::nullopt;
    }
    const auto left = spec.substr(0, dash);
    const auto right = spec.substr(dash + 1);
    const auto parse_u64 = [](std::string_view text) -> std::optional<std::size_t> {
        if (text.empty()) {
            return std::nullopt;
        }
        std::size_t value = 0;
        const auto [ptr, ec] = std::from_chars(text.data(), text.data() + text.size(), value);
        if (ec != std::errc{} || ptr != text.data() + text.size()) {
            return std::nullopt;
        }
        return value;
    };
    if (left.empty()) {
        const auto suffix = parse_u64(right);
        if (!suffix || *suffix == 0) {
            return std::nullopt;
        }
        const auto count = std::min(*suffix, total);
        return ByteRange{total - count, total - 1};
    }
    const auto start = parse_u64(left);
    if (!start || *start >= total) {
        return std::nullopt;
    }
    if (right.empty()) {
        return ByteRange{*start, total - 1};
    }
    const auto end = parse_u64(right);
    if (!end || *end < *start) {
        return std::nullopt;
    }
    return ByteRange{*start, std::min(*end, total - 1)};
}

} // namespace

MediaReply upload_media_single(Store& store, const Config& config, std::string_view token,
                               Id generation, Id conversation, std::string_view mime_type,
                               std::string_view filename, std::string_view body) {
    const auto session = media_session(store, config, token, generation);
    if (!session) {
        return from_wire(wire_error(session.error()));
    }
    const auto media_id = random_id();
    if (!media_id) {
        return error_reply(Error::TemporarilyUnavailable);
    }
    const auto mime = sanitize_mime(mime_type);
    const auto name = sanitize_filename(filename);
    const auto bytes = std::as_bytes(std::span(body.data(), body.size()));
    const auto stored =
        store.put_media_single(*session, conversation, *media_id, mime, name, bytes, current_time());
    if (!stored) {
        return from_wire(wire_error(stored.error()));
    }
    return MediaReply{200, meta_json(*stored).dump(), "application/json", {}, {}, false, false};
}

MediaReply init_media_upload(Store& store, const Config& config, std::string_view token,
                             Id generation, Id conversation, std::string_view body) {
    const auto session = media_session(store, config, token, generation);
    if (!session) {
        return from_wire(wire_error(session.error()));
    }
    const auto doc = parse_json(body);
    if (!doc || !doc->is_object()) {
        return error_reply(Error::InvalidArgument);
    }
    std::string raw_mime = "application/octet-stream";
    if (doc->contains("mime_type") && (*doc)["mime_type"].is_string()) {
        raw_mime = (*doc)["mime_type"].as_string();
    }
    std::string raw_name;
    if (doc->contains("filename") && (*doc)["filename"].is_string()) {
        raw_name = (*doc)["filename"].as_string();
    }
    const auto media_id = random_id();
    if (!media_id) {
        return error_reply(Error::TemporarilyUnavailable);
    }
    const auto mime = sanitize_mime(raw_mime);
    const auto name = sanitize_filename(raw_name);
    const auto created =
        store.create_media_upload(*session, conversation, *media_id, mime, name, current_time());
    if (!created) {
        return from_wire(wire_error(created.error()));
    }
    auto reply = Json::object();
    reply["media_id"] = encode_id(*media_id);
    reply["chunk_size"] = static_cast<Sequence>(kMediaChunkBytes);
    reply["max_bytes"] = static_cast<Sequence>(kMediaMaxBytes);
    return MediaReply{200, reply.dump(), "application/json", {}, {}, false, false};
}

MediaReply upload_media_chunk(Store& store, const Config& config, std::string_view token,
                              Id generation, Id conversation, Id media_id, Sequence chunk_index,
                              std::string_view body) {
    const auto session = media_session(store, config, token, generation);
    if (!session) {
        return from_wire(wire_error(session.error()));
    }
    const auto bytes = std::as_bytes(std::span(body.data(), body.size()));
    const auto stored = store.put_media_chunk(*session, conversation, media_id, chunk_index, bytes);
    if (!stored) {
        return from_wire(wire_error(stored.error()));
    }
    auto reply = Json::object();
    reply["ok"] = true;
    return MediaReply{200, reply.dump(), "application/json", {}, {}, false, false};
}

MediaReply complete_media_upload(Store& store, const Config& config, std::string_view token,
                                 Id generation, Id conversation, Id media_id, std::string_view body) {
    const auto session = media_session(store, config, token, generation);
    if (!session) {
        return from_wire(wire_error(session.error()));
    }
    const auto doc = parse_json(body);
    if (!doc || !doc->is_object() || !doc->contains("chunks") || !(*doc)["chunks"].is_number()) {
        return error_reply(Error::InvalidArgument);
    }
    const auto chunks = (*doc)["chunks"].get_as<Sequence>();
    const auto completed = store.complete_media_upload(*session, conversation, media_id, chunks);
    if (!completed) {
        return from_wire(wire_error(completed.error()));
    }
    return MediaReply{200, meta_json(*completed).dump(), "application/json", {}, {}, false, false};
}

MediaReply download_media(Store& store, const Config& config, std::string_view token, Id generation,
                          Id conversation, Id media_id, std::string_view range_header) {
    const auto session = media_session(store, config, token, generation);
    if (!session) {
        return from_wire(wire_error(session.error()));
    }
    const auto media = store.get_media(*session, conversation, media_id);
    if (!media) {
        return from_wire(wire_error(media.error()));
    }
    const std::string disposition =
        std::string(is_inline_safe(media->meta.mime_type) ? "inline" : "attachment");
    const auto total = media->content.size();
    if (!range_header.empty()) {
        const auto range = parse_range(range_header, total);
        if (!range) {
            return MediaReply{416, {}, "application/json", {}, "bytes */" + std::to_string(total),
                              false, true};
        }
        const auto length = range->end - range->start + 1;
        std::string slice(reinterpret_cast<const char*>(media->content.data() + range->start),
                          length);
        const std::string content_range = "bytes " + std::to_string(range->start) + "-" +
                                          std::to_string(range->end) + "/" + std::to_string(total);
        return MediaReply{206, std::move(slice), media->meta.mime_type, disposition, content_range,
                          true, true};
    }
    std::string payload(reinterpret_cast<const char*>(media->content.data()), total);
    return MediaReply{200, std::move(payload), media->meta.mime_type, disposition, {}, true, true};
}

} // namespace lim::server
