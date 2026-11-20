module;
#include <cstdio>
#include <cstdlib>
#include <source_location>

export module lim.test;

export namespace lim::test {

template <typename Condition>
void check(const Condition& condition,
           std::source_location location = std::source_location::current()) {
    if (!condition) {
        std::fprintf(stderr, "%s:%u: check failed\n", location.file_name(), location.line());
        std::exit(EXIT_FAILURE);
    }
}

} // namespace lim::test
