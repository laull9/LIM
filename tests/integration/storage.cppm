#include <algorithm>
#include <array>
#include <barrier>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <expected>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

import lim.test;
import lim.storage;

using lim::test::check;

namespace {

lim::Id id(std::uint32_t value) {
    lim::Id result;
    for (auto& octet : std::span(result.bytes).first<4>()) {
        octet = static_cast<std::byte>(value & 0xff);
        value >>= 8;
    }
    return result;
}

const lim::Id kGeneration = id(1);
const lim::Session kAlice{id(2), id(3), kGeneration, id(4)};
const lim::Session kBob{id(5), id(6), kGeneration, id(7)};
const lim::Id kRoom = id(8);
const std::array kPayload{std::byte{0}, std::byte{0xff}, std::byte{'A'}};

template <typename T>
void has_error(const lim::Result<T>& result, lim::Error error,
               std::optional<lim::Sequence> seq = std::nullopt) {
    check(!result);
    if (result.error().code != error || result.error().sequence != seq) {
        std::fprintf(stderr, "error code %d, expected %d\n", static_cast<int>(result.error().code),
                     static_cast<int>(error));
        check(false);
    }
}

std::unique_ptr<lim::Store> open(const lim::StorageOptions& options) {
    auto opened = lim::open_store(options, kGeneration);
    if (!opened) {
        std::fprintf(stderr, "open error code %d\n", static_cast<int>(opened.error()));
        check(false);
    }
    return std::move(*opened);
}

void create_room(lim::Store& store, lim::Id room) {
    check(store.create_host_conversation(room));
    check(store.set_member(room, kAlice.device, true));
    check(store.set_member(room, kBob.device, true));
}

void round_trip(const lim::StorageOptions& options) {
    auto alice = open(options);
    auto bob = open(options);
    check(alice->register_device(kAlice));
    check(alice->register_device(kAlice));
    check(alice->register_device(kBob));
    auto forged = kAlice;
    forged.credential = kBob.credential;
    has_error(alice->register_device(forged), lim::Error::Unauthenticated);

    create_room(*alice, kRoom);
    check(alice->create_host_conversation(kRoom));
    const auto empty = bob->read(kBob, {kRoom, 0, {}});
    check(empty && empty->up_to == 0 && empty->events.empty());
    has_error(bob->read(kBob, {id(999), 0, {}}), lim::Error::NotFoundOrForbidden);
    has_error(bob->read(forged, {kRoom, 0, {}}), lim::Error::Unauthenticated);
    auto stale = kAlice;
    stale.generation = id(99);
    has_error(bob->read(stale, {kRoom, 0, {}}), lim::Error::RecoveryRequired);
    const auto wrong_generation = lim::open_store(options, stale.generation);
    check(!wrong_generation &&
          wrong_generation.error() == lim::StorageOpenError::GenerationMismatch);

    const lim::Append send{kRoom, id(10), lim::HostContent::Binary, kPayload};
    auto invalid = send;
    invalid.payload = {};
    has_error(alice->append(kAlice, invalid), lim::Error::InvalidArgument);
    const std::vector<std::byte> oversized(lim::kMessageBytes + 1);
    invalid.payload = oversized;
    has_error(alice->append(kAlice, invalid), lim::Error::PayloadTooLarge);
    invalid = send;
    invalid.format = lim::MlsMessage{id(11), 1};
    has_error(alice->append(kAlice, invalid), lim::Error::ProfileMismatch);

    const auto first = alice->append(kAlice, send);
    check(first && first->seq == 1 && !first->replayed);
    alice.reset();
    alice = open(options);
    const auto replay = alice->append(kAlice, send);
    check(replay && replay->seq == 1 && replay->replayed);
    auto changed = send;
    changed.payload = std::span(kPayload).subspan(1);
    has_error(alice->append(kAlice, changed), lim::Error::IdempotencyConflict);
    changed = send;
    changed.format = lim::HostContent::Text;
    has_error(alice->append(kAlice, changed), lim::Error::IdempotencyConflict);

    const auto second = bob->append(kBob, send);
    check(second && second->seq == 2 && !second->replayed);
    const auto page = bob->read(kBob, {kRoom, 0, 1});
    check(page && page->up_to == 1 && page->events.size() == 1);
    const auto& event = page->events[0];
    check(event.seq == 1 && event.sender_device == kAlice.device);
    check(event.kind == lim::EventKind::Message &&
          event.client_message_id == send.client_message_id);
    check(std::get<lim::HostContent>(event.format) == lim::HostContent::Binary);
    check(std::ranges::equal(event.payload, kPayload));
    has_error(bob->read(kBob, {kRoom, -1, {}}), lim::Error::InvalidArgument);
    has_error(bob->read(kBob, {kRoom, 2, 1}), lim::Error::InvalidArgument);
    has_error(bob->read(kBob, {kRoom, 0, 3}), lim::Error::InvalidArgument);

    has_error(alice->expire_through(kRoom, 3), lim::Error::InvalidArgument);
    check(alice->expire_through(kRoom, 1));
    check(alice->expire_through(kRoom, 0));
    has_error(alice->append(kAlice, send), lim::Error::IdempotencyExpired, 1);
    has_error(bob->read(kBob, {kRoom, 0, {}}), lim::Error::CursorExpired, 1);
    const auto tail = bob->read(kBob, {kRoom, 1, {}});
    check(tail && tail->up_to == 2 && tail->events.size() == 1 && tail->events[0].seq == 2);

    check(alice->set_member(kRoom, kBob.device, false));
    has_error(bob->read(kBob, {kRoom, 1, {}}), lim::Error::NotFoundOrForbidden);
    has_error(bob->append(kBob, send), lim::Error::NotFoundOrForbidden);
    check(alice->set_member(kRoom, kBob.device, true));
    has_error(bob->read(kBob, {kRoom, 1, {}}), lim::Error::CursorExpired, 2);
    has_error(bob->append(kBob, send), lim::Error::NotFoundOrForbidden);

    auto new_key = send;
    new_key.client_message_id = id(12);
    const auto third = bob->append(kBob, new_key);
    check(third && third->seq == 3);
    check(alice->set_member(kRoom, kBob.device, true));
    const auto rejoined = bob->read(kBob, {kRoom, 2, {}});
    check(rejoined && rejoined->events.size() == 1 && rejoined->events[0].seq == 3);
    // Pages own their bytes after subsequent transactions and connection close.
    bob.reset();
    check(std::ranges::equal(event.payload, kPayload));
}

void pagination(lim::Store& store) {
    const auto small_room = id(20);
    create_room(store, small_room);
    for (std::size_t index = 0; index < lim::kPageEvents + 1; ++index) {
        check(store.append(kAlice, {small_room, id(static_cast<std::uint32_t>(index)),
                                    lim::HostContent::Json, kPayload}));
    }
    auto first = store.read(kBob, {small_room, 0, {}});
    check(first && first->events.size() == lim::kPageEvents);
    check(store.append(kAlice, {small_room, id(999), lim::HostContent::Text, kPayload}));
    const auto second = store.read(kBob, {small_room, first->events.back().seq, first->up_to});
    check(second && second->up_to == first->up_to && second->events.size() == 1);
    check(second->events.front().seq == first->up_to);

    const auto big_room = id(21);
    create_room(store, big_room);
    const std::vector<std::byte> largest(lim::kMessageBytes, std::byte{0x81});
    constexpr auto capacity = lim::kPageBytes / (lim::kMessageBytes + lim::kHeaderBytes + 8);
    for (std::size_t index = 0; index <= capacity; ++index) {
        check(store.append(kAlice, {big_room, id(static_cast<std::uint32_t>(index)),
                                    lim::HostContent::Binary, largest}));
    }
    first = store.read(kBob, {big_room, 0, {}});
    check(first && first->events.size() == capacity);
    check(std::ranges::equal(first->events.back().payload, largest));
    const auto last = store.read(kBob, {big_room, first->events.back().seq, first->up_to});
    check(last && last->events.size() == 1 && last->events[0].seq == first->up_to);
}

void concurrent_writes(const lim::StorageOptions& options, lim::Store& alice) {
    auto other = open(options);
    const auto room = id(30);
    create_room(alice, room);
    const lim::Append cmd{room, id(31), lim::HostContent::Binary, kPayload};
    std::barrier start(2);
    std::optional<lim::Result<lim::Receipt>> other_receipt;
    std::jthread writer([&] {
        start.arrive_and_wait();
        other_receipt = other->append(kAlice, cmd);
    });
    start.arrive_and_wait();
    const auto receipt = alice.append(kAlice, cmd);
    writer.join();
    check(receipt && other_receipt && *other_receipt);
    check(receipt->seq == 1 && (*other_receipt)->seq == 1);
    check(receipt->replayed != (*other_receipt)->replayed);

    std::jthread second_writer([&] {
        start.arrive_and_wait();
        other_receipt = other->append(kBob, cmd);
    });
    start.arrive_and_wait();
    const auto revoked = alice.revoke_device(kBob.device);
    second_writer.join();
    check(revoked && other_receipt);
    if (!*other_receipt) {
        has_error(*other_receipt, lim::Error::DeviceRevoked);
    }
    const auto page = alice.read(kAlice, {room, 0, {}});
    check(page && page->events.size() == (*other_receipt ? 2 : 1));
    has_error(other->append(kBob, cmd), lim::Error::DeviceRevoked);
    has_error(other->read(kBob, {room, 0, {}}), lim::Error::DeviceRevoked);
    has_error(alice.set_member(room, kBob.device, true), lim::Error::DeviceRevoked);
    has_error(alice.register_device(kBob), lim::Error::DeviceRevoked);
}

void verify_rejected_write(const lim::StorageOptions& options, bool fault_active) {
    auto store = open(options);
    const lim::Append cmd{kRoom, id(500), lim::HostContent::Binary, kPayload};
    const auto receipt = store->append(kAlice, cmd);
    if (fault_active) {
        has_error(receipt, lim::Error::TemporarilyUnavailable);
    } else {
        check(receipt && !receipt->replayed && receipt->seq == 4);
    }
    const auto page = store->read(kAlice, {kRoom, 3, {}});
    check(page && page->up_to == (fault_active ? 3 : 4));
    if (fault_active) {
        check(page->events.empty());
    } else {
        check(page->events.size() == 1 && page->events.front().client_message_id == id(500));
    }
}

} // namespace

int main(int argc, char** argv) {
    check(argc == 3 || argc == 4);
    const std::string_view backend(argv[1]);
    check(backend == "sqlite" || backend == "postgresql");
    const lim::StorageOptions options = backend == "sqlite"
                                            ? lim::StorageOptions(lim::SqliteOptions{argv[2]})
                                            : lim::StorageOptions(lim::PostgresOptions{argv[2]});
    if (argc == 4) {
        const std::string_view scenario(argv[3]);
        if (scenario == "unknown-schema") {
            const auto result = lim::open_store(options, kGeneration);
            check(!result && result.error() == lim::StorageOpenError::UnsupportedSchema);
        } else {
            check(scenario == "write-reject" || scenario == "write-retry");
            verify_rejected_write(options, scenario == "write-reject");
        }
        return 0;
    }
    for (const lim::StorageOptions& invalid :
         {lim::StorageOptions(lim::SqliteOptions{}), lim::StorageOptions(lim::PostgresOptions{})}) {
        const auto result = lim::open_store(invalid, kGeneration);
        check(!result && result.error() == lim::StorageOpenError::InvalidConfiguration);
    }
    std::puts("round trip, authorization and retention");
    round_trip(options);
    auto store = open(options);
    std::puts("pagination and wire size budget");
    pagination(*store);
    std::puts("concurrent retries and device revocation");
    concurrent_writes(options, *store);
}
