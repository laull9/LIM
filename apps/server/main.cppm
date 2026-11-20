#include <exception>
#include <filesystem>

#include <iostream>
#include <string_view>

import lim.server.config;
import lim.server.http;
import lim.storage;

int main(int argc, char** argv) {
    if (argc == 2 && std::string_view(argv[1]) == "--help") {
        std::cout << "Usage: lim-server --config FILE\n";
        return 0;
    }
    if (argc != 3 || std::string_view(argv[1]) != "--config") {
        std::cerr << "Usage: lim-server --config FILE\n";
        return 2;
    }
    try {
        const auto config = lim::server::load_config(argv[2]);
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
