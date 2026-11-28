/**
 * What the sign-in routes log when the email provider fails in the background (09 §2): a provider
 * that already raised its alert is not logged a second time; an unexpected failure still is.
 */
import { type EmailSender, type Logger, markAlerted } from "@your-move/server";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, PROD_ENV } from "./test-harness.js";

let h: Harness | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

async function requestWith(make: (log: Logger) => EmailSender): Promise<Harness> {
  const created = createHarness(PROD_ENV, {
    sender: {
      send: (message) => make(created.platform.log).send(message),
    },
  });
  h = created;
  const response = await created.request("POST", "/api/v1/auth/otp/request", {
    email: "a@example.org",
  });
  expect(response.status).toBe(202);
  await created.emails();
  return created;
}

describe("a failed send in the background (A5-S-9)", () => {
  it("logs nothing more when the provider already alerted", async () => {
    const harness = await requestWith((log) => ({
      send() {
        log.error("gmail rejected the message: it was not sent", { alert: "email_send_failed" });
        return Promise.reject(markAlerted(new Error("rejected")));
      },
    }));
    const errors = harness.logs.filter((line) => line["level"] === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ alert: "email_send_failed" });
  });

  it("still logs a failure the provider did not alert for", async () => {
    const harness = await requestWith(() => ({
      send: () => Promise.reject(new TypeError("boom")),
    }));
    const errors = harness.logs.filter((line) => line["level"] === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: "background task failed", errorClass: "TypeError" });
  });
});
