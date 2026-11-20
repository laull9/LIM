#include <array>
#include <cstddef>
#include <expected>
#include <span>
#include <vector>

import lim.chat;
import lim.frame;

int main() {
    using enum lim::wire::FrameError;
    using lim::wire::PayloadClass;
    using lim::wire::split_frame;
    using B = std::byte;
    constexpr auto message = PayloadClass::Message;
    const std::array frame{B{0}, B{0}, B{0}, B{2}, B{'{'}, B{'}'}, B{0xff}};
    const auto parsed = split_frame(frame, message);
    if (!parsed || parsed->header.data() != frame.data() + 4 || parsed->header.size() != 2 ||
        parsed->payload.size() != 1 || parsed->payload[0] != B{0xff}) {
        return 1;
    }
    const auto fails = [message](std::span<const B> bytes, lim::wire::FrameError error) {
        const auto result = split_frame(bytes, message);
        return !result && result.error() == error;
    };
    if (!fails({}, Truncated) || !fails(std::span(frame).first(5), Truncated) ||
        !fails(std::array<B, 4>{}, EmptyHeader) ||
        !fails(std::array{B{0}, B{0}, B{0x10}, B{1}}, HeaderTooLarge)) {
        return 2;
    }
    std::vector<B> boundary(4 + lim::kHeaderBytes + lim::kMessageBytes);
    boundary[2] = B{0x10};
    if (!split_frame(boundary, message)) {
        return 3;
    }
    boundary.push_back(B{});
    if (!fails(boundary, PayloadTooLarge) || !split_frame(boundary, PayloadClass::Control)) {
        return 4;
    }
    boundary.resize(4 + lim::kHeaderBytes + lim::kControlBytes + 1);
    const auto oversized = split_frame(boundary, PayloadClass::Control);
    return oversized || oversized.error() != PayloadTooLarge ? 5 : 0;
}
