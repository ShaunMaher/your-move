import { configure } from "@testing-library/react";

// Under the full parallel suite (all packages at once) a test's first render can wait seconds on
// CPU, so Testing Library's default 1 s findBy/waitFor budget flakes. Unloaded, every test here
// takes well under 200 ms: this is headroom for contention (11 §4), not a sleep, and a passing
// wait still returns the moment its condition holds.
configure({ asyncUtilTimeout: 10_000 });
