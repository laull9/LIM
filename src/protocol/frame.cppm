module;
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

export module lim.frame;
import lim.chat;

export namespace lim::wire {

struct FrameView {
    std::span<const std::byte> header;
    std::span<const std::byte> payload;
};

enum class FrameError { Truncated, EmptyHeader, HeaderTooLarge, PayloadTooLarge };
enum class PayloadClass { Message, Control };

// Split one complete WS message or HTTP record. Views borrow the input.
// The transport caps reassembly before calling this and determines the allowed
// payload class from its route or the validated header before dispatching.
[[nodiscard]] std::expected<FrameView, FrameError>
split_frame(std::span<const std::byte> frame, PayloadClass payload_class) noexcept {
    constexpr std::size_t prefix = 4;
    if (frame.size() < prefix) {
        return std::unexpected(FrameError::Truncated);
    }

    std::uint32_t length = 0;
    for (const auto octet : frame.first(prefix)) {
        length = (length << 8) | std::to_integer<std::uint32_t>(octet);
    }
    if (length == 0) {
        return std::unexpected(FrameError::EmptyHeader);
    }
    if (length > kHeaderBytes) {
        return std::unexpected(FrameError::HeaderTooLarge);
    }

    const auto body = frame.subspan(prefix);
    if (length > body.size()) {
        return std::unexpected(FrameError::Truncated);
    }
    const auto payload = body.subspan(length);
    const auto limit = payload_class == PayloadClass::Message ? kMessageBytes : kControlBytes;
    if (payload.size() > limit) {
        return std::unexpected(FrameError::PayloadTooLarge);
    }
    return FrameView{body.first(length), payload};
}

} // namespace lim::wire
