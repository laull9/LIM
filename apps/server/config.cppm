module;
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#include <LJson.hpp>
#include <openssl/crypto.h>
#include <openssl/evp.h>

export module lim.server.config;
import lim.storage;

export namespace lim::server {

using Json = LJson::Json;
using Digest = std::array<unsigned char, 32>;

struct Device {
    Session session;
    Digest token_digest;
};

struct Config {
    StorageOptions storage;
    Id generation;
    std::uint16_t port = 7400;
    Digest operator_digest;
    std::vector<Device> devices;
};

struct Principal {
    const Session* session = nullptr;
    bool is_operator = false;
};

[[nodiscard]] std::optional<Json> parse_json(std::string_view input);
[[nodiscard]] std::optional<Id> parse_id(std::string_view input);
[[nodiscard]] std::string encode_id(Id id);
[[nodiscard]] Config load_config(const std::filesystem::path& path);
[[nodiscard]] Principal authenticate(const Config& config, std::string_view token);

} // namespace lim::server

namespace lim::server {
namespace {

constexpr std::size_t kConfigBytes = 128 * 1024;
constexpr std::size_t kDeviceLimit = 256;
constexpr std::size_t kJsonDepth = 32;
constexpr std::string_view kHex = "0123456789abcdef";

std::optional<unsigned char> hex_byte(char first, char second) {
    const auto high = kHex.find(first);
    const auto low = kHex.find(second);
    if (high == kHex.npos || low == kHex.npos) {
        return std::nullopt;
    }
    return static_cast<unsigned char>((high << 4) | low);
}

std::optional<Digest> parse_digest(std::string_view input) {
    Digest digest{};
    if (input.size() != digest.size() * 2) {
        return std::nullopt;
    }
    for (std::size_t i = 0; i < digest.size(); ++i) {
        const auto byte = hex_byte(input[i * 2], input[i * 2 + 1]);
        if (!byte) {
            return std::nullopt;
        }
        digest[i] = *byte;
    }
    return digest;
}

std::string string_field(const Json& object, const char* key) {
    if (!object.is_object() || !object.contains(key)) {
        throw std::runtime_error(std::string("missing config field ") + key);
    }
    const auto value = object[key];
    if (!value.is_string()) {
        throw std::runtime_error(std::string("expected string in ") + key);
    }
    return value.as_string();
}

Id id_field(const Json& object, const char* key) {
    if (const auto id = parse_id(string_field(object, key)); id && *id != Id{}) {
        return *id;
    }
    throw std::runtime_error(std::string("invalid UUID in ") + key);
}

Digest digest_field(const Json& object, const char* key) {
    if (const auto digest = parse_digest(string_field(object, key))) {
        return *digest;
    }
    throw std::runtime_error(std::string("invalid token SHA-256 in ") + key);
}

struct FreeJson {
    void operator()(yyjson_doc* doc) const noexcept { yyjson_doc_free(doc); }
};

bool valid_tree(yyjson_val* node, std::size_t depth) {
    if (depth > kJsonDepth) {
        return false;
    }
    if (yyjson_is_obj(node)) {
        std::unordered_set<std::string_view> keys;
        auto fields = yyjson_obj_iter_with(node);
        while (auto* key = yyjson_obj_iter_next(&fields)) {
            const std::string_view name(yyjson_get_str(key), yyjson_get_len(key));
            if (!keys.insert(name).second || !valid_tree(yyjson_obj_iter_get_val(key), depth + 1)) {
                return false;
            }
        }
    } else if (yyjson_is_arr(node)) {
        auto values = yyjson_arr_iter_with(node);
        while (auto* value = yyjson_arr_iter_next(&values)) {
            if (!valid_tree(value, depth + 1)) {
                return false;
            }
        }
    }
    return true;
}

} // namespace

std::optional<Json> parse_json(std::string_view input) {
    // LJson uses yyjson. Inspect its read-only tree here because the DOM does
    // not expose object-key iteration, and reject duplicate keys before copying.
    std::unique_ptr<yyjson_doc, FreeJson> parsed(yyjson_read(input.data(), input.size(), 0));
    if (!parsed || !valid_tree(yyjson_doc_get_root(parsed.get()), 0)) {
        return std::nullopt;
    }
    return Json(parsed.get());
}

std::optional<Id> parse_id(std::string_view input) {
    if (input.size() != 36) {
        return std::nullopt;
    }
    Id id;
    std::size_t offset = 0;
    for (std::size_t i = 0; i < id.bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            if (input[offset++] != '-') {
                return std::nullopt;
            }
        }
        const auto byte = hex_byte(input[offset], input[offset + 1]);
        if (!byte) {
            return std::nullopt;
        }
        id.bytes[i] = static_cast<std::byte>(*byte);
        offset += 2;
    }
    return id;
}

std::string encode_id(Id id) {
    std::string result;
    result.reserve(36);
    for (std::size_t i = 0; i < id.bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            result.push_back('-');
        }
        const auto byte = std::to_integer<unsigned int>(id.bytes[i]);
        result.push_back(kHex[byte >> 4]);
        result.push_back(kHex[byte & 0xf]);
    }
    return result;
}

Config load_config(const std::filesystem::path& path) {
    std::ifstream file(path, std::ios::binary);
    std::string text(kConfigBytes + 1, '\0');
    file.read(text.data(), static_cast<std::streamsize>(text.size()));
    if (!file.eof() || file.bad() || file.gcount() <= 0) {
        throw std::runtime_error("cannot read config or config exceeds 128 KiB");
    }
    text.resize(static_cast<std::size_t>(file.gcount()));
    const auto parsed = parse_json(text);
    if (!parsed || !parsed->is_object()) {
        throw std::runtime_error("config must be a JSON object");
    }
    const auto& doc = *parsed;
    Config config{};
    config.generation = id_field(doc, "generation");
    config.operator_digest = digest_field(doc, "operator_token_sha256");

    if (doc.contains("port")) {
        config.port = doc["port"].get_as<std::uint16_t>();
    }

    if (!doc.contains("storage")) {
        throw std::runtime_error("missing config storage object");
    }
    const auto storage = doc["storage"];
    const auto backend = string_field(storage, "backend");
    if (backend == "sqlite") {
        const auto name = string_field(storage, "file");
        if (name.empty() || name == ":memory:" || name.find('\0') != name.npos) {
            throw std::runtime_error("SQLite file must be a persistent path");
        }
        config.storage = SqliteOptions{path.parent_path() / std::filesystem::path(name)};
    } else if (backend == "postgresql") {
        const auto* conninfo = std::getenv("LIM_SERVER_PG");
        if (!conninfo || *conninfo == '\0') {
            throw std::runtime_error("set LIM_SERVER_PG to the dedicated PostgreSQL database");
        }
        config.storage = PostgresOptions{conninfo};
    } else {
        throw std::runtime_error("storage backend must be sqlite or postgresql");
    }

    if (!doc.contains("devices")) {
        throw std::runtime_error("missing config devices array");
    }
    const auto devices = doc["devices"];
    if (!devices.is_array() || devices.json_size() > kDeviceLimit) {
        throw std::runtime_error("devices must be an array of at most 256 records");
    }
    for (std::size_t index = 0; index < devices.json_size(); ++index) {
        const auto entry = devices[index];
        const Session session{id_field(entry, "account"), id_field(entry, "device"),
                              config.generation, id_field(entry, "credential")};
        const auto digest = digest_field(entry, "token_sha256");
        const auto collision = std::ranges::any_of(config.devices, [&](const Device& known) {
            return known.session.device == session.device ||
                   known.session.credential == session.credential || known.token_digest == digest;
        });
        if (collision || digest == config.operator_digest) {
            throw std::runtime_error("duplicate device, credential or token digest");
        }
        config.devices.push_back(Device{session, digest});
    }
    return config;
}

Principal authenticate(const Config& config, std::string_view token) {
    if (!parse_digest(token)) {
        return {};
    }
    Digest digest{};
    unsigned int size = 0;
    if (EVP_Digest(token.data(), token.size(), digest.data(), &size, EVP_sha256(), nullptr) != 1 ||
        size != digest.size()) {
        throw std::runtime_error("cannot hash bearer token");
    }
    Principal principal;
    principal.is_operator =
        CRYPTO_memcmp(digest.data(), config.operator_digest.data(), digest.size()) == 0;
    for (const auto& device : config.devices) {
        if (CRYPTO_memcmp(digest.data(), device.token_digest.data(), digest.size()) == 0) {
            principal.session = &device.session;
        }
    }
    return principal;
}

} // namespace lim::server
