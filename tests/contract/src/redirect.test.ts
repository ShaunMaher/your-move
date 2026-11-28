/**
 * Why the gmail provider asks `fetch` for `redirect: "manual"` (09 §2, A5-S-4): under workerd,
 * `"error"` is not a mode the runtime supports (the request throws before it is sent), while
 * `"manual"` is accepted. The provider's own handling of a redirect answer is unit-tested with a
 * fetch double in packages/server; it can't be probed here, because Wrangler's test harness sends
 * a Worker's outbound requests through a proxy that follows redirects itself.
 *
 * workerd needs SSE4.2 on x86-64, which CI's amd64 runner offers; this file runs in the `test` job.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

/** The probe Worker: reports how `fetch` answers for the target under a redirect mode. */
const PROBE_WORKER = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      const response = await fetch(url.searchParams.get("target"), {
        redirect: url.searchParams.get("mode"),
      });
      return Response.json({ outcome: "response", status: response.status, type: response.type });
    } catch (error) {
      return Response.json({ outcome: "threw", name: error instanceof Error ? error.name : "?" });
    }
  },
};
`;

let harness: TestHarness;
let dir = "";
let redirector: Server;
let target = "";
beforeAll(async () => {
  // A local server that answers every request with a redirect.
  redirector = createServer((_request, response) => {
    response.writeHead(302, { location: "http://redirect-target.invalid/x" }).end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  target = `http://127.0.0.1:${(redirector.address() as AddressInfo).port.toString()}/`;
  dir = mkdtempSync(join(tmpdir(), "redirect-probe-"));
  writeFileSync(join(dir, "probe.js"), PROBE_WORKER);
  writeFileSync(
    join(dir, "wrangler.toml"),
    'name = "redirect-probe"\nmain = "probe.js"\ncompatibility_date = "2026-11-01"\n',
  );
  harness = createTestHarness({ root: dir, workers: [{ configPath: "wrangler.toml" }] });
  await harness.listen();
}, 60_000);
afterAll(async () => {
  await harness.close();
  redirector.close();
  rmSync(dir, { recursive: true, force: true });
});

async function probe(mode: string): Promise<Record<string, unknown>> {
  const response = await harness
    .getWorker()
    .fetch(`/probe?mode=${mode}&target=${encodeURIComponent(target)}`);
  return (await response.json()) as Record<string, unknown>;
}

describe("fetch redirect modes under workerd", () => {
  it("`manual` is accepted: the request is sent", async () => {
    expect(await probe("manual")).toMatchObject({ outcome: "response" });
  });

  it("`error` is not supported", async () => {
    expect(await probe("error")).toMatchObject({ outcome: "threw" });
  });
});
