import { configure } from "@testing-library/react";

// Slow waits under load come from two causes. A test that asserts right after a heading appears
// can run before React's passive effects have (observed: Settings theme, 2 of 30 runs with 20 busy
// processes); those tests wait for the effect's result instead. And the default 1 s findBy/waitFor
// budget can run out while the CPU is contended (inferred, not observed). Unloaded, every test
// here takes well under 200 ms: 10 s is headroom for contention, not a measurement, and a passing
// wait still returns the moment its condition holds. Waits that assert something goes away say
// `{ timeout: 1000 }` so a regression fails fast.
configure({ asyncUtilTimeout: 10_000 });
