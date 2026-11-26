import { configure } from "@testing-library/react";

// Two web tests flaked under the full parallel suite, and the failures could not be reproduced, so
// the cause (the default 1 s findBy/waitFor budget running out while the CPU is contended) is
// inferred, not observed. Unloaded, every test here takes well under 200 ms: 10 s is headroom for
// contention, not a measurement, and a passing wait still returns the moment its condition
// holds. Waits that assert something goes away say `{ timeout: 1000 }` so a regression fails fast.
configure({ asyncUtilTimeout: 10_000 });
