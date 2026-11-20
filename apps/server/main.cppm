#include <algorithm>
#include <exception>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string_view>
#include <vector>

import lim.server.config;
import lim.server.http;
import lim.storage;

namespace {

constexpr std::string_view kUsage = "Usage: lim-server --config FILE [--recover-from OLD_CONFIG]\n";

std::string_view recovery_error(lim::StorageOpenError error) {
    using lim::StorageOpenError;
    switch (error) {
    case StorageOpenError::InvalidConfiguration:
        return "invalid recovery configuration or unchanged generation";
    case StorageOpenError::ConnectionFailed:
        return "cannot connect to the restored database";
    case StorageOpenError::InitializationFailed:
        return "cannot apply recovery to the restored database";
    case StorageOpenError::UnsupportedSchema:
        return "unsupported restored database schema";
    case StorageOpenError::GenerationMismatch:
        return "restored database generation does not match the old config";
    case StorageOpenError::RecoveryDeviceMismatch:
        return "reviewed device is absent, revoked or belongs to a different account";
    case StorageOpenError::RecoveryCredentialReuse:
        return "reviewed device credential ID already exists in the snapshot";
    }
    return "unknown storage error";
}

int recover(const lim::server::Config& config, const std::filesystem::path& old_path) {
    const auto old = lim::server::load_config(old_path);
    const auto token_was_used = [&](const lim::server::Digest& token) {
        return old.operator_digest == token ||
               std::ranges::any_of(
                   old.devices, [&](const auto& device) { return device.token_digest == token; });
    };
    if (token_was_used(config.operator_digest)) {
        throw std::runtime_error("rotate all operator and device tokens before recovery");
    }
    std::vector<lim::Session> reviewed;
    reviewed.reserve(config.devices.size());
    for (const auto& device : config.devices) {
        if (token_was_used(device.token_digest)) {
            throw std::runtime_error("rotate all operator and device tokens before recovery");
        }
        reviewed.push_back(device.session);
    }
    const auto result =
        lim::recover_store(config.storage, {old.generation, config.generation, reviewed});
    if (!result) {
        std::cerr << "lim-server: " << recovery_error(result.error()) << '\n';
        return 1;
    }
    std::cout << "recovered generation=" << lim::server::encode_id(config.generation) << '\n';
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::string_view(argv[1]) == "--help") {
        std::cout << kUsage;
        return 0;
    }
    const bool recovery = argc == 5 && std::string_view(argv[3]) == "--recover-from";
    if ((argc != 3 && !recovery) || std::string_view(argv[1]) != "--config") {
        std::cerr << kUsage;
        return 2;
    }
    try {
        const auto config = lim::server::load_config(argv[2]);
        if (recovery) {
            return recover(config, argv[4]);
        }
        auto store = lim::open_store(config.storage, config.generation);
        if (!store) {
            std::cerr << "lim-server: cannot open storage (code " << static_cast<int>(store.error())
                      << ")\n";
            return 1;
        }
        for (const auto& device : config.devices) {
            const auto registered = (*store)->register_device(device.session);
            if (!registered && registered.error().code != lim::Error::DeviceRevoked) {
                std::cerr << "lim-server: cannot register configured device "
                          << lim::server::encode_id(device.session.device) << '\n';
                return 1;
            }
        }
        return lim::server::serve(config, **store);
    } catch (const std::exception& error) {
        std::cerr << "lim-server: " << error.what() << '\n';
        return 1;
    }
}
