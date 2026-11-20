#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <span>
#include <string_view>
#include <system_error>
#include <variant>

import lim.storage;

namespace {

using lim::Sequence;

constexpr lim::Id demo_id(unsigned int kind, std::uint64_t value = 0) {
    lim::Id id;
    id.bytes[0] = std::byte{'L'};
    id.bytes[1] = std::byte{'I'};
    id.bytes[2] = std::byte{'M'};
    id.bytes[3] = static_cast<std::byte>(kind);
    for (auto& octet : std::span(id.bytes).last<8>()) {
        octet = static_cast<std::byte>(value & 0xff);
        value >>= 8;
    }
    return id;
}

constexpr auto kGeneration = demo_id(1);
constexpr auto kRoom = demo_id(2);

struct Persona {
    std::string_view name;
    lim::Session session;
};

constexpr std::array kPersonas{
    Persona{"alice", {demo_id(3, 1), demo_id(4, 1), kGeneration, demo_id(5, 1)}},
    Persona{"bob", {demo_id(3, 2), demo_id(4, 2), kGeneration, demo_id(5, 2)}},
};

void usage(std::ostream& out) {
    out << "Usage: lim_demo [--sqlite FILE | --postgresql] COMMAND\n"
           "  init\n"
           "  send <alice|bob> <message-key> <text>\n"
           "  read <alice|bob> <after> [up-to]\n"
           "The default backend is SQLite (lim-demo.db). --postgresql reads LIM_DEMO_PG.\n";
}

const Persona* persona(std::string_view name) {
    for (const auto& current : kPersonas) {
        if (current.name == name) {
            return &current;
        }
    }
    return nullptr;
}

std::optional<Sequence> sequence(std::string_view text) {
    Sequence value = 0;
    const auto* end = text.data() + text.size();
    const auto [next, error] = std::from_chars(text.data(), end, value);
    if (error != std::errc{} || next != end || value < 0) {
        return std::nullopt;
    }
    return value;
}

bool valid_utf8(std::string_view text) {
    unsigned int remaining = 0;
    unsigned int low = 0x80;
    unsigned int high = 0xbf;
    for (const auto character : text) {
        const auto byte = static_cast<unsigned char>(character);
        if (remaining != 0) {
            if (byte < low || byte > high) {
                return false;
            }
            --remaining;
            low = 0x80;
            high = 0xbf;
        } else if (byte >= 0xc2 && byte <= 0xdf) {
            remaining = 1;
        } else if (byte >= 0xe0 && byte <= 0xef) {
            remaining = 2;
            low = byte == 0xe0 ? 0xa0 : 0x80;
            high = byte == 0xed ? 0x9f : 0xbf;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
            remaining = 3;
            low = byte == 0xf0 ? 0x90 : 0x80;
            high = byte == 0xf4 ? 0x8f : 0xbf;
        } else if (byte >= 0x80) {
            return false;
        }
    }
    return remaining == 0;
}

void write_text(std::span<const std::byte> payload) {
    constexpr std::string_view hex = "0123456789abcdef";
    std::cout << '"';
    for (const auto octet : payload) {
        const auto byte = std::to_integer<unsigned int>(octet);
        if (byte == '"' || byte == '\\') {
            std::cout << '\\' << static_cast<char>(byte);
        } else if (byte < 0x20 || byte == 0x7f) {
            std::cout << "\\u00" << hex[byte >> 4] << hex[byte & 0xf];
        } else {
            std::cout << static_cast<char>(byte);
        }
    }
    std::cout << '"';
}

std::string_view error_name(lim::Error error) {
    using enum lim::Error;
    switch (error) {
    case Unauthenticated:
        return "unauthenticated (run init first)";
    case DeviceRevoked:
        return "device_revoked";
    case NotFoundOrForbidden:
        return "not_found_or_forbidden";
    case InvalidArgument:
        return "invalid_argument";
    case PayloadTooLarge:
        return "payload_too_large";
    case IdempotencyConflict:
        return "idempotency_conflict";
    case IdempotencyExpired:
        return "idempotency_expired";
    case CursorExpired:
        return "cursor_expired";
    case RecoveryRequired:
        return "recovery_required";
    case Overloaded:
        return "overloaded";
    default:
        return "storage_unavailable";
    }
}

int report(lim::Failure failure) {
    std::cerr << "lim_demo: " << error_name(failure.code);
    if (failure.sequence) {
        std::cerr << " seq=" << *failure.sequence;
    }
    std::cerr << '\n';
    return 1;
}

int initialize(lim::Store& store) {
    if (auto result = store.create_host_conversation(kRoom); !result) {
        return report(result.error());
    }
    for (const auto& actor : kPersonas) {
        if (auto result = store.register_device(actor.session); !result) {
            return report(result.error());
        }
        if (auto result = store.set_member(kRoom, actor.session.device, true); !result) {
            return report(result.error());
        }
    }
    std::cout << "ready room=demo members=alice,bob\n";
    return 0;
}

int send(lim::Chat& chat, const Persona& actor, Sequence key, std::string_view text) {
    const auto client_id = demo_id(6, static_cast<std::uint64_t>(key));
    const auto payload = std::as_bytes(std::span(text.data(), text.size()));
    const auto result =
        chat.append(actor.session, {kRoom, client_id, lim::HostContent::Text, payload});
    if (!result) {
        return report(result.error());
    }
    std::cout << "accepted seq=" << result->seq << " replayed=" << std::boolalpha
              << result->replayed << '\n';
    return 0;
}

int read(lim::Chat& chat, const Persona& actor, Sequence after, std::optional<Sequence> up_to) {
    const auto result = chat.read(actor.session, {kRoom, after, up_to});
    if (!result) {
        return report(result.error());
    }
    for (const auto& event : result->events) {
        std::string_view sender = "unknown";
        for (const auto& candidate : kPersonas) {
            if (candidate.session.device == event.sender_device) {
                sender = candidate.name;
                break;
            }
        }
        std::cout << "event seq=" << event.seq << " sender=" << sender << " text=";
        write_text(event.payload);
        std::cout << '\n';
    }
    const auto next_after = result->events.empty() ? after : result->events.back().seq;
    std::cout << "page up_to=" << result->up_to << " next_after=" << next_after << '\n';
    return 0;
}

int run(std::span<char*> args) {
    if (!args.empty() && std::string_view(args.front()) == "--help") {
        usage(std::cout);
        return 0;
    }

    lim::StorageOptions storage = lim::SqliteOptions{"lim-demo.db"};
    if (args.size() >= 2 && std::string_view(args.front()) == "--sqlite") {
        storage = lim::SqliteOptions{args[1]};
        args = args.subspan(2);
    } else if (!args.empty() && std::string_view(args.front()) == "--postgresql") {
        const auto* conninfo = std::getenv("LIM_DEMO_PG");
        if (!conninfo || *conninfo == '\0') {
            std::cerr << "lim_demo: set LIM_DEMO_PG to the dedicated demo database\n";
            return 2;
        }
        storage = lim::PostgresOptions{conninfo};
        args = args.subspan(1);
    }

    const std::string_view command = args.empty() ? "" : args.front();
    const bool init = command == "init" && args.size() == 1;
    const bool sending = command == "send" && args.size() == 4;
    const bool reading = command == "read" && (args.size() == 3 || args.size() == 4);
    if (!init && !sending && !reading) {
        usage(std::cerr);
        return 2;
    }

    const Persona* actor = nullptr;
    Sequence position = 0;
    std::optional<Sequence> up_to;
    if (!init) {
        actor = persona(args[1]);
        const auto parsed = sequence(args[2]);
        if (!actor || !parsed || (sending && *parsed == 0)) {
            std::cerr << "lim_demo: use alice or bob and a valid decimal message key or cursor\n";
            return 2;
        }
        position = *parsed;
        if (reading && args.size() == 4) {
            up_to = sequence(args[3]);
            if (!up_to || *up_to < position) {
                std::cerr
                    << "lim_demo: up-to must be a decimal cursor at or after the lower bound\n";
                return 2;
            }
        }
    }

    if (sending) {
        const std::string_view text(args[3]);
        if (text.empty() || text.size() > lim::kMessageBytes || !valid_utf8(text)) {
            std::cerr << "lim_demo: message must be 1 to 65536 bytes of valid UTF-8\n";
            return 2;
        }
    }

    auto store = lim::open_store(storage, kGeneration);
    if (!store) {
        std::cerr << "lim_demo: cannot open demo storage";
        if (store.error() == lim::StorageOpenError::GenerationMismatch) {
            std::cerr << " (database belongs to another instance)";
        } else if (store.error() == lim::StorageOpenError::UnsupportedSchema) {
            std::cerr << " (unsupported schema version)";
        }
        std::cerr << '\n';
        return 1;
    }
    if (init) {
        return initialize(**store);
    }
    if (sending) {
        return send(**store, *actor, position, args[3]);
    }
    return read(**store, *actor, position, up_to);
}

} // namespace

int main(int argc, char** argv) {
    return run(std::span(argv + 1, static_cast<std::size_t>(argc - 1)));
}
