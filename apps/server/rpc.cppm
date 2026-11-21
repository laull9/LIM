module;
#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <optional>
#include <ranges>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <LJson.hpp>
#include <LString.hpp>

export module lim.server.rpc;
import lim.server.auth;
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
constexpr std::size_t kEventMetadataBytes = 256;
constexpr std::size_t kMaxEncodedPayload = 4 * ((kMessageBytes + 2) / 3);
constexpr Sequence kAccessLifetime = 15 * 60;
constexpr Sequence kRefreshLifetime = 30 * 24 * 60 * 60;

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

std::string_view trim(std::string_view input) {
    while (!input.empty() && (input.front() == ' ' || input.front() == '\t')) {
        input.remove_prefix(1);
    }
    while (!input.empty() && (input.back() == ' ' || input.back() == '\t')) {
        input.remove_suffix(1);
    }
    return input;
}

std::string device_name_field(const Json& params) {
    const auto raw = text_field(params, "device_name");
    const auto value = trim(raw);
    if (value.empty() || value.size() > 64 || !LString::valid_utf8(value)) {
        throw InvalidParams{};
    }
    return std::string(value);
}

std::string search_prefix(std::string_view input) {
    const auto value = trim(input);
    if (value.empty() || value.size() > 32 || !LString::valid_utf8(value)) {
        throw InvalidParams{};
    }
    std::string result;
    result.reserve(value.size());
    for (const char raw : value) {
        const auto byte = static_cast<unsigned char>(raw);
        if (byte < 0x20 || byte == 0x7f || byte == '%' || byte == '\\') {
            throw InvalidParams{};
        }
        if (byte >= 'A' && byte <= 'Z') {
            result.push_back(static_cast<char>(byte + ('a' - 'A')));
        } else {
            result.push_back(raw);
        }
    }
    return result;
}

std::string make_system_payload(std::string_view title, std::string_view text) {
    auto doc = Json::object();
    doc["v"] = 1;
    doc["lim_msg"] = true;
    doc["kind"] = "system";
    if (!title.empty()) {
        doc["title"] = std::string(title);
    }
    doc["text"] = std::string(text);
    doc["ts"] = current_time() * 1000;
    return doc.dump();
}

Result<DefaultRooms> ensure_defaults(Store& store, Id account, std::string_view username,
                                     std::string_view display_name, std::string_view device_name) {
    const auto self_room = random_id();
    const auto system_room = random_id();
    const auto sys_key = random_id();
    const auto self_key = random_id();
    if (!self_room || !system_room || !sys_key || !self_key) {
        throw std::runtime_error("cannot create default conversation identifiers");
    }
    const std::string welcome_text =
        "欢迎来到 LIM，" + std::string(display_name) + "（@" + std::string(username) +
        "）！当前设备「" + std::string(device_name) +
        "」已自动登记。你可以先在「与自己对话」里测试文字、语音、照片、视频或文件，也可以在左侧「联系人」中按用户名搜索好友。当前会话为宿主可读模式。";
    const std::string self_text =
        "这里是你的私人空间「与自己对话」。在这里发送的笔记、语音、照片、视频和文件都会在你的所有已登录设备之间实时同步。";
    const auto welcome_json = make_system_payload("欢迎使用 LIM", welcome_text);
    const auto self_json = make_system_payload("我的随手记", self_text);
    return store.ensure_default_conversations(account, *self_room, *system_room, *sys_key,
                                              *self_key, welcome_json, self_json);
}

struct TokenPair {
    std::string access;
    std::string refresh;
    SecretDigest access_digest;
    SecretDigest refresh_digest;
    Sequence now;
    Sequence access_expires;
    Sequence refresh_expires;
};

TokenPair make_tokens() {
    const auto access = random_token();
    const auto refresh = random_token();
    const auto access_digest = access ? secret_digest(*access) : std::nullopt;
    const auto refresh_digest = refresh ? secret_digest(*refresh) : std::nullopt;
    if (!access || !refresh || !access_digest || !refresh_digest) {
        throw std::runtime_error("cannot create authentication tokens");
    }
    const auto now = current_time();
    return TokenPair{*access, *refresh, *access_digest, *refresh_digest, now,
                     now + kAccessLifetime, now + kRefreshLifetime};
}

Json auth_response(const AuthContext& context, const TokenPair& tokens) {
    auto result = Json::object();
    result["generation"] = encode_id(context.session.generation);
    result["account"] = encode_id(context.session.account);
    result["device"] = encode_id(context.session.device);
    result["username"] = context.username;
    result["display_name"] = context.display_name;
    result["access_token"] = tokens.access;
    result["refresh_token"] = tokens.refresh;
    result["access_expires_at"] = tokens.access_expires;
    result["refresh_expires_at"] = tokens.refresh_expires;
    return result;
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

Json profile_json(const AccountProfile& profile) {
    auto result = Json::object();
    result["account"] = encode_id(profile.id);
    result["username"] = profile.username;
    result["display_name"] = profile.display_name;
    return result;
}

Json summary_json(const ConversationSummary& summary) {
    auto result = Json::object();
    result["conversation_id"] = encode_id(summary.id);
    result["after"] = std::to_string(summary.after);
    result["last_seq"] = std::to_string(summary.last_seq);
    result["profile"] = "host";
    if (summary.account_scoped) {
        result["kind"] = summary.kind;
        result["title"] = summary.title;
        Json members = Json::array();
        for (const auto& member : summary.members) {
            members.push_back(profile_json(member));
        }
        result["members"] = std::move(members);
    }
    return result;
}

Json register_account(Store& store, const Json& params, std::atomic<std::uint64_t>& revision) {
    const auto username = normalized_username(text_field(params, "username"));
    const auto raw_display_name = text_field(params, "display_name");
    const auto display_name = trim(raw_display_name);
    const auto password = text_field(params, "password");
    const auto device = id_field(params, "device_id");
    const auto name = device_name_field(params);
    if (!username || !valid_display_name(display_name)) {
        throw InvalidParams{};
    }
    const auto hash = hash_password(password);
    if (!hash) {
        throw InvalidParams{};
    }
    const auto account = random_id();
    const auto credential = random_id();
    const auto login = random_id();
    if (!account || !credential || !login) {
        throw std::runtime_error("cannot create account identifiers");
    }
    require(store.create_account(*account, *username, display_name, *hash));
    const auto tokens = make_tokens();
    const auto context =
        store.create_login(*login, *account, device, name, *credential, tokens.access_digest,
                           tokens.refresh_digest, tokens.now, tokens.access_expires,
                           tokens.refresh_expires);
    require(context);
    require(ensure_defaults(store, *account, *username, display_name, name));
    revision.fetch_add(1);
    return auth_response(*context, tokens);
}

Json login_account(Store& store, const Json& params, std::atomic<std::uint64_t>& revision) {
    const auto username = normalized_username(text_field(params, "username"));
    const auto password = text_field(params, "password");
    const auto device = id_field(params, "device_id");
    const auto name = device_name_field(params);
    if (!username) {
        throw InvalidParams{};
    }
    const auto account = store.account_by_username(*username);
    if (!account || !verify_password(password, account->password_hash)) {
        throw from_failure(Failure{Error::Unauthenticated, std::nullopt});
    }
    const auto credential = random_id();
    const auto login = random_id();
    if (!credential || !login) {
        throw std::runtime_error("cannot create login identifiers");
    }
    const auto tokens = make_tokens();
    const auto context =
        store.create_login(*login, account->id, device, name, *credential, tokens.access_digest,
                           tokens.refresh_digest, tokens.now, tokens.access_expires,
                           tokens.refresh_expires);
    require(context);
    require(ensure_defaults(store, account->id, account->username, account->display_name, name));
    if (const auto notice_key = random_id()) {
        const auto notice = make_system_payload(
            "安全提醒", "设备「" + name + "」（" + encode_id(device).substr(0, 8) + "…）已登录你的账号。");
        (void)store.append_system_notice(account->id, *notice_key, notice);
    }
    revision.fetch_add(1);
    return auth_response(*context, tokens);
}

Json refresh_account(Store& store, const Json& params) {
    const auto old_refresh = secret_digest(text_field(params, "refresh_token"));
    if (!old_refresh) {
        throw InvalidParams{};
    }
    const auto tokens = make_tokens();
    const auto context = store.rotate_login(*old_refresh, tokens.access_digest,
                                            tokens.refresh_digest, tokens.now,
                                            tokens.access_expires, tokens.refresh_expires);
    require(context);
    return auth_response(*context, tokens);
}

Json logout_account(Store& store, const Principal& principal) {
    if (!principal.account_session || !principal.login || !principal.session) {
        throw RpcError{-32001, "Device authentication required"};
    }
    require(store.logout(*principal.login, principal.session->account));
    return accepted();
}

Json search_accounts(Store& store, const Principal& principal, const Json& params) {
    const auto& session = device_session(principal, params);
    const auto prefix = search_prefix(text_field(params, "query"));
    const auto accounts = store.search_accounts(session, prefix, 20);
    require(accounts);
    Json users = Json::array();
    for (const auto& account : *accounts) {
        users.push_back(profile_json(account));
    }
    auto result = Json::object();
    result["users"] = std::move(users);
    return result;
}

Json start_conversation(Store& store, const Principal& principal, const Json& params) {
    const auto& session = device_session(principal, params);
    const auto requested = field(params, "account_ids");
    if (!requested.is_array() || requested.json_size() == 0 || requested.json_size() > 8) {
        throw InvalidParams{};
    }
    if (requested.json_size() == 1 && requested[0].is_string()) {
        const auto single = parse_id(requested[0].as_string());
        if (single && *single == session.account) {
            const auto defaults = ensure_defaults(
                store, session.account, principal.username,
                principal.display_name.empty() ? principal.username : principal.display_name,
                "当前设备");
            require(defaults);
            return summary_json(defaults->self_room);
        }
    }
    std::vector<Id> targets;
    for (std::size_t index = 0; index < requested.json_size(); ++index) {
        const auto value = requested[index];
        if (!value.is_string()) {
            throw InvalidParams{};
        }
        const auto id = parse_id(value.as_string());
        if (!id || *id == Id{} || *id == session.account ||
            std::ranges::find(targets, *id) != targets.end()) {
            throw InvalidParams{};
        }
        targets.push_back(*id);
    }
    std::string title;
    if (params.contains("title")) {
        title = std::string(trim(text_field(params, "title")));
        if (title.empty() || title.size() > 64 || !LString::valid_utf8(title)) {
            throw InvalidParams{};
        }
    }
    const auto direct = targets.size() == 1;
    if (!direct && title.empty()) {
        throw InvalidParams{};
    }
    const auto conversation = random_id();
    if (!conversation) {
        throw std::runtime_error("cannot create conversation identifier");
    }
    std::string direct_key;
    if (direct) {
        const auto self_key = encode_id(session.account);
        const auto target_key = encode_id(targets.front());
        const auto ordered = std::minmax(self_key, target_key);
        direct_key = ordered.first + ":" + ordered.second;
    }
    const auto summary = store.start_conversation(
        session, *conversation, targets, direct ? "direct" : "group", title, direct_key);
    require(summary);
    return summary_json(*summary);
}

Json list_contacts(Store& store, const Principal& principal, const Json& params) {
    const auto& session = device_session(principal, params);
    const auto contacts = store.list_contacts(session);
    require(contacts);
    Json entries = Json::array();
    for (const auto& contact : *contacts) {
        entries.push_back(profile_json(contact));
    }
    auto result = Json::object();
    result["contacts"] = std::move(entries);
    return result;
}

Json add_contact(Store& store, const Principal& principal, const Json& params) {
    const auto& session = device_session(principal, params);
    const auto target = id_field(params, "account_id");
    const auto contact = store.add_contact(session, target, current_time());
    require(contact);
    auto result = Json::object();
    result["contact"] = profile_json(*contact);
    return result;
}

Json remove_contact(Store& store, const Principal& principal, const Json& params) {
    const auto& session = device_session(principal, params);
    const auto target = id_field(params, "account_id");
    require(store.remove_contact(session, target));
    return accepted();
}

Json list_account_devices(Store& store, const Principal& principal, const Json& params) {
    const auto& session = device_session(principal, params);
    const auto devices = store.list_devices(session);
    require(devices);
    Json entries = Json::array();
    for (const auto& device : *devices) {
        auto entry = Json::object();
        entry["device_id"] = encode_id(device.id);
        entry["name"] = device.name;
        entry["created_at"] = device.created_at;
        entry["last_seen"] = device.last_seen;
        entry["revoked"] = device.revoked;
        entries.push_back(std::move(entry));
    }
    auto result = Json::object();
    result["devices"] = std::move(entries);
    return result;
}

Json remove_account_device(Store& store, const Principal& principal, const Json& params,
                           std::atomic<std::uint64_t>& revision) {
    const auto& session = device_session(principal, params);
    const auto target_device = id_field(params, "device_id");
    require(store.remove_device(session, target_device));
    if (const auto notice_key = random_id()) {
        const auto notice = make_system_payload(
            "设备已撤销", "设备 " + encode_id(target_device).substr(0, 8) + "… 已被撤销，无法继续访问会话。");
        (void)store.append_system_notice(session.account, *notice_key, notice);
    }
    revision.fetch_add(1);
    return accepted();
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
        item["account_id"] = encode_id(event.sender_account);
        item["username"] = event.username;
        item["display_name"] = event.display_name;
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
        entries.push_back(summary_json(item));
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
    if (method == "account.register") {
        return register_account(store, params, revision);
    }
    if (method == "account.login") {
        return login_account(store, params, revision);
    }
    if (method == "account.refresh") {
        return refresh_account(store, params);
    }
    if (method == "account.logout") {
        return logout_account(store, principal);
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
        if (principal.account_session) {
            result["username"] = principal.username;
            result["display_name"] = principal.display_name;
        }
        return result;
    }
    if (method == "account.search") {
        return search_accounts(store, principal, params);
    }
    if (method == "contact.list") {
        return list_contacts(store, principal, params);
    }
    if (method == "contact.add") {
        return add_contact(store, principal, params);
    }
    if (method == "contact.remove") {
        return remove_contact(store, principal, params);
    }
    if (method == "conversation.start") {
        return start_conversation(store, principal, params);
    }
    if (method == "device.list") {
        return list_account_devices(store, principal, params);
    }
    if (method == "device.remove") {
        return remove_account_device(store, principal, params, revision);
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
    const auto principal = authenticate(store, config, token);
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
