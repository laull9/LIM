module;
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <iostream>
#include <mutex>
#include <optional>
#include <semaphore>
#include <string>
#include <string_view>
#include <utility>

#define CINATRA_LOG_INFO cinatra::NULL_LOGGER
#define CINATRA_LOG_DEBUG cinatra::NULL_LOGGER
#include <LWeb.hpp>
#include <pkgs/cinatra/asio/signal_set.hpp>

#include <pkgs/cinatra/asio/thread_pool.hpp>

export module lim.server.http;
import lim.server.binary;
import lim.server.config;
import lim.server.contract;
import lim.server.rpc;
import lim.storage;

export namespace lim::server {

// Listens on IPv4 loopback and runs database calls on one bounded worker queue.
int serve(const Config& config, Store& store);

} // namespace lim::server

namespace lim::server {
namespace {

using Status = LWeb::HttpStatus;
using namespace std::chrono_literals;

bool same_ascii(std::string_view a, std::string_view b) {
    const auto lowercase = [](char c) { return c >= 'A' && c <= 'Z' ? c + ('a' - 'A') : c; };
    return std::ranges::equal(a, b,
                              [lowercase](char x, char y) { return lowercase(x) == lowercase(y); });
}

std::string_view bearer_token(std::string_view authorization) {
    constexpr std::string_view scheme = "Bearer ";
    if (!same_ascii(authorization.substr(0, scheme.size()), scheme)) {
        return {};
    }
    const auto token = authorization.substr(scheme.size());
    const auto first = token.find_first_not_of(' ');
    return first == token.npos ? std::string_view{} : token.substr(first);
}

bool media_type_is(std::string_view content_type, std::string_view expected) {
    const auto media_type = content_type.substr(0, content_type.find(';'));
    const auto last = media_type.find_last_not_of(" \t");
    return last != media_type.npos && same_ascii(media_type.substr(0, last + 1), expected);
}

void respond(LWeb::Response& response, Status status, std::string body = {},
             std::string_view type = "application/json") {
    response.add_header("Cache-Control", "no-store");
    if (status != Status::no_content) {
        response.add_header("Content-Type", std::string(type));
    }
    response.set_status(status);
    response.set_content(std::move(body));
}

void respond_wire(LWeb::Response& response, const Config& config, WireReply reply) {
    if (reply.up_to) {
        response.add_header("LIM-Generation", encode_id(config.generation));
        response.add_header("LIM-Up-To", std::to_string(*reply.up_to));
    }
    if (reply.status == 401) {
        response.add_header("WWW-Authenticate", "Bearer");
    }
    if (reply.status == 503) {
        response.add_header("Retry-After", "1");
    }
    respond(response, static_cast<Status>(reply.status), std::move(reply.body), reply.type);
}

struct HeaderCounts {
    unsigned int length = 0;
    unsigned int authorization = 0;
    unsigned int generation = 0;
    bool transfer_encoding = false;
};

HeaderCounts count_headers(const LWeb::Request& request) {
    HeaderCounts counts;
    for (const auto& header : request.get_headers()) {
        counts.length += same_ascii(header.name, "Content-Length");
        counts.authorization += same_ascii(header.name, "Authorization");
        counts.generation += same_ascii(header.name, "LIM-Generation");
        counts.transfer_encoding |= same_ascii(header.name, "Transfer-Encoding");
    }
    return counts;
}

LWeb::Task<> reject_framing(LWeb::Request& request, LWeb::Response& response) {
    response.set_status_and_content(Status::bad_request, "");
    response.set_keepalive(false);
    response.set_delay(true);
    co_await request.get_conn()->reply();
    request.get_conn()->close();
}

template <std::ptrdiff_t Limit> struct Slot {
    std::counting_semaphore<Limit>& slots;
    ~Slot() { slots.release(); }
};

class RequestLifetime {
  public:
    bool enter() {
        const std::lock_guard lock(mutex_);
        if (stopping_) {
            return false;
        }
        ++active_;
        return true;
    }

    void leave() {
        const std::lock_guard lock(mutex_);
        if (--active_ == 0) {
            drained_.notify_one();
        }
    }

    bool stopping() const { return stopping_.load(); }

    void stop_and_wait() {
        std::unique_lock lock(mutex_);
        stopping_ = true;
        drained_.wait(lock, [this] { return active_ == 0; });
    }

  private:
    std::mutex mutex_;
    std::condition_variable drained_;
    std::atomic_bool stopping_{false};
    std::size_t active_ = 0;
};

class RequestGuard {
  public:
    explicit RequestGuard(RequestLifetime& lifetime)
        : lifetime_(lifetime), entered_(lifetime.enter()) {}
    RequestGuard(const RequestGuard&) = delete;
    RequestGuard& operator=(const RequestGuard&) = delete;

    ~RequestGuard() {
        if (entered_) {
            lifetime_.leave();
        }
    }

    explicit operator bool() const { return entered_; }

  private:
    RequestLifetime& lifetime_;
    bool entered_;
};

class Routes {
  public:
    Routes(const Config& config, Store& store) : config_(config), store_(store) {}

    void stop_and_wait() { requests_.stop_and_wait(); }

    LWeb::Task<> ready(LWeb::Request& request, LWeb::Response& response) {
        const RequestGuard active(requests_);
        if (!active) {
            respond(response, Status::service_unavailable);
            co_return;
        }
        if (request.get_method() != "GET") {
            response.add_header("Allow", "GET");
            respond(response, Status::method_not_allowed);
            co_return;
        }
        if (!slots_.try_acquire()) {
            respond(response, Status::service_unavailable);
            co_return;
        }
        const Slot slot{slots_};
        try {
            const auto ready = co_await coro_io::post(
                [this] { return store_.check_generation(config_.generation).has_value(); },
                worker_.get_executor());
            if (ready.value()) {
                respond(response, Status::ok, R"({"status":"ready"})");
            } else {
                respond(response, Status::service_unavailable);
            }
        } catch (const std::exception&) {
            respond(response, Status::service_unavailable);
        }
    }

    LWeb::Task<> binary_send(LWeb::Request& request, LWeb::Response& response);
    LWeb::Task<> binary_read(LWeb::Request& request, LWeb::Response& response);
    LWeb::Task<> wait(LWeb::Request& request, LWeb::Response& response);

    LWeb::Task<> rpc(LWeb::Request& request, LWeb::Response& response) {
        const RequestGuard active(requests_);
        if (!active) {
            respond(response, Status::service_unavailable);
            co_return;
        }
        if (request.get_method() != "POST") {
            response.add_header("Allow", "POST");
            respond(response, Status::method_not_allowed);
            co_return;
        }
        const auto counts = count_headers(request);
        if (counts.transfer_encoding || counts.length > 1) {
            co_await reject_framing(request, response);
            co_return;
        }
        if (!media_type_is(request.get_header_value("Content-Type"), "application/json")) {
            respond(response, Status::unsupported_media_type);
            co_return;
        }
        if (counts.authorization > 1) {
            respond(response, Status::bad_request);
            co_return;
        }
        if (!slots_.try_acquire()) {
            response.add_header("Retry-After", "1");
            respond(response, Status::service_unavailable);
            co_return;
        }
        const Slot slot{slots_};

        const auto token = bearer_token(request.get_header_value("Authorization"));
        const auto body = request.get_body();
        try {
            auto outcome = co_await coro_io::post(
                [this, token, body] { return handle_rpc(store_, config_, token, body, revision_); },
                worker_.get_executor());
            auto& reply = outcome.value();
            if (reply) {
                respond(response, Status::ok, std::move(*reply));
            } else {
                respond(response, Status::no_content);
            }
        } catch (const std::exception&) {
            respond(response, Status::internal_server_error);
        }
        // Keep the admission slot until the response is written, including when
        // the client reads slowly. The request/response outlive this handler.
        response.set_delay(true);
        co_await request.get_conn()->reply();
    }

  private:
    template <typename Operation>
    LWeb::Task<> serve_wire(LWeb::Request& request, LWeb::Response& response, Operation operation) {
        if (!slots_.try_acquire()) {
            respond_wire(response, config_, wire_error({Error::Overloaded, std::nullopt}));
            co_return;
        }
        const Slot slot{slots_};
        try {
            auto outcome = co_await coro_io::post(std::move(operation), worker_.get_executor());
            respond_wire(response, config_, std::move(outcome.value()));
        } catch (const std::exception&) {
            respond(response, Status::internal_server_error);
        }
        response.set_delay(true);
        co_await request.get_conn()->reply();
    }

    const Config& config_;
    Store& store_;
    RequestLifetime requests_;
    std::atomic<std::uint64_t> revision_{0};
    std::counting_semaphore<4> slots_{4};
    std::counting_semaphore<16> waits_{16};
    asio::thread_pool worker_{1};
};

LWeb::Task<> Routes::binary_send(LWeb::Request& request, LWeb::Response& response) {
    const RequestGuard active(requests_);
    if (!active) {
        respond(response, Status::service_unavailable);
        co_return;
    }
    if (request.get_method() != "POST") {
        response.add_header("Allow", "POST");
        respond(response, Status::method_not_allowed);
        co_return;
    }
    const auto counts = count_headers(request);
    if (counts.transfer_encoding || counts.length > 1) {
        co_await reject_framing(request, response);
        co_return;
    }
    if (!media_type_is(request.get_header_value("Content-Type"), kRecordType)) {
        respond(response, Status::unsupported_media_type);
        co_return;
    }
    const auto conversation = parse_id(LWeb::Param(request, "id"));
    if (!conversation || *conversation == Id{} || counts.authorization > 1) {
        respond_wire(response, config_, wire_error({Error::InvalidArgument, std::nullopt}));
        co_return;
    }
    const auto token = bearer_token(request.get_header_value("Authorization"));
    const auto body = request.get_body();
    co_await serve_wire(request, response, [this, token, conversation = *conversation, body] {
        return append_record(store_, config_, token, conversation, body, revision_);
    });
}

struct ReadRequest {
    std::string_view token;
    Id generation;
    Read query;
};

std::optional<ReadRequest> read_request(LWeb::Request& request, const HeaderCounts& counts) {
    const auto after = parse_sequence(LWeb::Query(request, "after_seq"));
    const auto conversation = parse_id(LWeb::Param(request, "id"));
    const auto generation = parse_id(request.get_header_value("LIM-Generation"));
    if (!after || !conversation || *conversation == Id{} || !generation ||
        counts.authorization > 1 || counts.generation != 1) {
        return std::nullopt;
    }
    const auto upper = LWeb::Query(request, "up_to");
    const auto up_to = parse_sequence(upper);
    if (!upper.empty() && !up_to) {
        return std::nullopt;
    }
    return ReadRequest{bearer_token(request.get_header_value("Authorization")),
                       *generation,
                       {*conversation, *after, up_to}};
}

LWeb::Task<> Routes::binary_read(LWeb::Request& request, LWeb::Response& response) {
    const RequestGuard active(requests_);
    if (!active) {
        respond(response, Status::service_unavailable);
        co_return;
    }
    if (request.get_method() != "GET") {
        response.add_header("Allow", "GET");
        respond(response, Status::method_not_allowed);
        co_return;
    }
    const auto counts = count_headers(request);
    if (counts.transfer_encoding || counts.length > 1) {
        co_await reject_framing(request, response);
        co_return;
    }
    const auto params = read_request(request, counts);
    if (!params) {
        respond_wire(response, config_, wire_error({Error::InvalidArgument, std::nullopt}));
        co_return;
    }
    co_await serve_wire(request, response, [this, params = *params] {
        return read_records(store_, config_, params.token, params.generation, params.query);
    });
}

LWeb::Task<> Routes::wait(LWeb::Request& request, LWeb::Response& response) {
    const RequestGuard active(requests_);
    if (!active) {
        respond(response, Status::service_unavailable);
        co_return;
    }
    if (request.get_method() != "GET") {
        response.add_header("Allow", "GET");
        respond(response, Status::method_not_allowed);
        co_return;
    }
    const auto counts = count_headers(request);
    if (counts.transfer_encoding || counts.length > 1) {
        co_await reject_framing(request, response);
        co_return;
    }
    const auto params = read_request(request, counts);
    if (!params || params->query.up_to) {
        respond_wire(response, config_, wire_error({Error::InvalidArgument, std::nullopt}));
        co_return;
    }
    if (!waits_.try_acquire()) {
        respond_wire(response, config_, wire_error({Error::Overloaded, std::nullopt}));
        co_return;
    }
    const Slot waiter{waits_};
    using Clock = std::chrono::steady_clock;
    auto next_check = Clock::now();
    const auto deadline = next_check + 5s;
    auto seen_revision = revision_.load();
    do {
        if (requests_.stopping()) {
            respond(response, Status::service_unavailable);
            co_return;
        }
        const auto now = Clock::now();
        const auto observed = revision_.load();
        const bool expired = now >= deadline;
        const bool due = expired || now >= next_check || observed != seen_revision;
        if (due && slots_.try_acquire()) {
            const Slot slot{slots_};
            try {
                auto outcome = co_await coro_io::post(
                    [this, params = *params, final_check = expired] {
                        return wait_for_events(store_, config_, params.token, params.generation,
                                               params.query.conversation, params.query.after,
                                               final_check);
                    },
                    worker_.get_executor());
                auto& reply = outcome.value();
                if (reply) {
                    respond_wire(response, config_, std::move(*reply));
                    co_return;
                }
            } catch (const std::exception&) {
                respond(response, Status::internal_server_error);
                co_return;
            }
            seen_revision = observed;
            // Recheck even if an embedded writer changes the database out of process.
            next_check = now + 1s;
        } else if (expired) {
            respond_wire(response, config_, wire_error({Error::Overloaded, std::nullopt}));
            co_return;
        }
        co_await coro_io::sleep_for(100ms, request.get_conn()->get_executor());
    } while (true);
}

} // namespace

int serve(const Config& config, Store& store) {
    Routes routes(config, store);
    LWeb::Application app({
        .address = "127.0.0.1",
        .port = config.port,
        .threads = 1,
        .max_body_size = kRpcRequestBytes,
        .max_header_size = 8 * 1024,
        .idle_timeout = 10s,
    });
    app.Native().set_shrink_to_fit(true);
    app.Any("/health/live", [](LWeb::Request& request, LWeb::Response& response) {
        if (request.get_method() == "GET") {
            respond(response, Status::ok, R"({"status":"live"})");
        } else {
            response.add_header("Allow", "GET");
            respond(response, Status::method_not_allowed);
        }
    });
    app.Any("/health/ready", &routes, &Routes::ready);
    app.Any("/rpc", &routes, &Routes::rpc);
    app.Any("/v1/conversations/:id/messages", &routes, &Routes::binary_send);
    app.Any("/v1/conversations/:id/events", &routes, &Routes::binary_read);
    app.Any("/v1/conversations/:id/wait", &routes, &Routes::wait);

    asio::io_context signals;
    asio::signal_set stop(signals, SIGINT, SIGTERM);
    stop.async_wait([&signals](std::error_code, int) { signals.stop(); });
    auto running = app.Start();
    if (running.hasResult() && running.value()) {
        std::cerr << "lim-server: cannot bind the loopback listener\n";
        return 1;
    }
    std::cout << "listening 127.0.0.1:" << app.Port() << std::endl;
    signals.run();
    // Let application timers and database coroutines release their request state
    // while the LWeb I/O executor can still resume them.
    routes.stop_and_wait();
    app.Stop();
    return 0;
}

} // namespace lim::server
