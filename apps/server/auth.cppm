module;
#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#include <LString.hpp>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

export module lim.server.auth;
import lim.storage;

export namespace lim::server {

[[nodiscard]] Sequence current_time();
[[nodiscard]] std::optional<std::string> normalized_username(std::string_view input);
[[nodiscard]] bool valid_display_name(std::string_view input);
[[nodiscard]] std::optional<std::string> hash_password(std::string_view password);
[[nodiscard]] bool verify_password(std::string_view password, std::string_view encoded);
[[nodiscard]] std::optional<Id> random_id();
[[nodiscard]] std::optional<std::string> random_token();
[[nodiscard]] std::optional<SecretDigest> secret_digest(std::string_view token);

} // namespace lim::server

namespace lim::server {
namespace {

constexpr std::string_view kHex = "0123456789abcdef";
constexpr std::uint64_t kScryptN = 32768;
constexpr std::uint64_t kScryptR = 8;
constexpr std::uint64_t kScryptP = 1;
constexpr std::uint64_t kScryptMemory = 64 * 1024 * 1024;

std::string hex(std::span<const unsigned char> bytes) {
    std::string result;
    result.reserve(bytes.size() * 2);
    for (const auto byte : bytes) {
        result.push_back(kHex[byte >> 4]);
        result.push_back(kHex[byte & 0xf]);
    }
    return result;
}

std::optional<std::vector<unsigned char>> unhex(std::string_view text) {
    if (text.size() % 2 != 0) {
        return std::nullopt;
    }
    std::vector<unsigned char> bytes;
    bytes.reserve(text.size() / 2);
    for (std::size_t i = 0; i < text.size(); i += 2) {
        const auto high = kHex.find(text[i]);
        const auto low = kHex.find(text[i + 1]);
        if (high == kHex.npos || low == kHex.npos) {
            return std::nullopt;
        }
        bytes.push_back(static_cast<unsigned char>((high << 4) | low));
    }
    return bytes;
}

bool is_space(char value) {
    return value == ' ' || value == '\t' || value == '\n' || value == '\r' || value == '\f' ||
           value == '\v';
}

std::string_view trim(std::string_view input) {
    while (!input.empty() && is_space(input.front())) {
        input.remove_prefix(1);
    }
    while (!input.empty() && is_space(input.back())) {
        input.remove_suffix(1);
    }
    return input;
}

std::optional<std::uint64_t> number(std::string_view input) {
    std::uint64_t value = 0;
    const auto [next, error] = std::from_chars(input.data(), input.data() + input.size(), value);
    if (error != std::errc{} || next != input.data() + input.size()) {
        return std::nullopt;
    }
    return value;
}

bool valid_token(std::string_view token) {
    return token.size() == 64 && std::ranges::all_of(token, [](char value) {
               return kHex.find(value) != kHex.npos;
           });
}

} // namespace

Sequence current_time() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

std::optional<std::string> normalized_username(std::string_view input) {
    const auto value = trim(input);
    if (value.size() < 3 || value.size() > 24) {
        return std::nullopt;
    }
    std::string result;
    result.reserve(value.size());
    for (const char raw : value) {
        const auto byte = static_cast<unsigned char>(raw);
        if (byte >= 'A' && byte <= 'Z') {
            result.push_back(static_cast<char>(byte + ('a' - 'A')));
        } else if ((byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9') || byte == '_') {
            result.push_back(static_cast<char>(byte));
        } else {
            return std::nullopt;
        }
    }
    return result;
}

bool valid_display_name(std::string_view input) {
    const auto value = trim(input);
    return !value.empty() && value.size() <= 48 && LString::valid_utf8(value);
}

std::optional<std::string> hash_password(std::string_view password) {
    if (password.size() < 8 || password.size() > 128) {
        return std::nullopt;
    }
    std::array<unsigned char, 16> salt{};
    std::array<unsigned char, 32> key{};
    if (RAND_bytes(salt.data(), static_cast<int>(salt.size())) != 1 ||
        EVP_PBE_scrypt(password.data(), password.size(), salt.data(), salt.size(), kScryptN,
                       kScryptR, kScryptP, kScryptMemory, key.data(), key.size()) != 1) {
        return std::nullopt;
    }
    return "scrypt$32768$8$1$" + hex(salt) + "$" + hex(key);
}

bool verify_password(std::string_view password, std::string_view encoded) {
    constexpr std::string_view prefix = "scrypt$";
    if (password.size() < 8 || password.size() > 128 || !encoded.starts_with(prefix)) {
        return false;
    }
    std::array<std::string_view, 4> fields{};
    auto rest = encoded.substr(prefix.size());
    for (auto& field : fields) {
        const auto separator = rest.find('$');
        if (separator == rest.npos && &field != &fields.back()) {
            return false;
        }
        field = rest.substr(0, separator);
        if (separator != rest.npos) {
            rest.remove_prefix(separator + 1);
        }
    }
    if (number(fields[0]) != kScryptN || number(fields[1]) != kScryptR ||
        number(fields[2]) != kScryptP) {
        return false;
    }
    const auto salt = unhex(fields[3]);
    const auto expected = unhex(rest);
    if (!salt || !expected || salt->size() != 16 || expected->size() != 32) {
        return false;
    }
    std::array<unsigned char, 32> actual{};
    if (EVP_PBE_scrypt(password.data(), password.size(), salt->data(), salt->size(), kScryptN,
                       kScryptR, kScryptP, kScryptMemory, actual.data(), actual.size()) != 1) {
        return false;
    }
    return CRYPTO_memcmp(actual.data(), expected->data(), actual.size()) == 0;
}

std::optional<Id> random_id() {
    Id id;
    if (RAND_bytes(reinterpret_cast<unsigned char*>(id.bytes.data()),
                   static_cast<int>(id.bytes.size())) != 1) {
        return std::nullopt;
    }
    return id;
}

std::optional<std::string> random_token() {
    std::array<unsigned char, 32> bytes{};
    if (RAND_bytes(bytes.data(), static_cast<int>(bytes.size())) != 1) {
        return std::nullopt;
    }
    return hex(bytes);
}

std::optional<SecretDigest> secret_digest(std::string_view token) {
    if (!valid_token(token)) {
        return std::nullopt;
    }
    std::array<unsigned char, 32> digest{};
    unsigned int size = 0;
    if (EVP_Digest(token.data(), token.size(), digest.data(), &size, EVP_sha256(), nullptr) != 1 ||
        size != digest.size()) {
        return std::nullopt;
    }
    SecretDigest result{};
    for (std::size_t i = 0; i < digest.size(); ++i) {
        result[i] = static_cast<std::byte>(digest[i]);
    }
    return result;
}

} // namespace lim::server
