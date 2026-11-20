#include <array>
#include <cstddef>
#include <span>
#include <vector>

import lim.test;
import lim.chat;
import lim.frame;

int main() {
    using lim::test::check;
    using enum lim::wire::FrameError;
    using lim::wire::PayloadClass;
    using lim::wire::split_frame;
    using B = std::byte;

    const std::array frame{B{0}, B{0}, B{0}, B{2}, B{'{'}, B{'}'}, B{0xff}};
    const auto parsed = split_frame(frame, PayloadClass::Message);
    check(parsed);
    check(parsed->header.data() == frame.data() + 4);
    check(parsed->header.size() == 2);
    check(parsed->payload.data() == frame.data() + 6);
    check(parsed->payload.size() == 1);

    const auto fails = [](std::span<const B> bytes, lim::wire::FrameError error,
                          PayloadClass kind = PayloadClass::Message) {
        const auto result = split_frame(bytes, kind);
        check(!result && result.error() == error);
    };
    fails({}, Truncated);
    fails(std::span(frame).first(5), Truncated);
    fails(std::array<B, 4>{}, EmptyHeader);
    fails(std::array{B{0}, B{0}, B{0x10}, B{1}}, HeaderTooLarge);

    std::vector<B> boundary(4 + lim::kHeaderBytes + lim::kMessageBytes);
    boundary[2] = B{0x10};
    check(split_frame(boundary, PayloadClass::Message));
    boundary.push_back(B{});
    fails(boundary, PayloadTooLarge);
    check(split_frame(boundary, PayloadClass::Control));
    boundary.resize(4 + lim::kHeaderBytes + lim::kControlBytes);
    check(split_frame(boundary, PayloadClass::Control));
    boundary.push_back(B{});
    fails(boundary, PayloadTooLarge, PayloadClass::Control);
}
