import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG } from "../test-support.js";
import { Privacy } from "./Privacy.js";

afterEach(cleanup);

const text = () => document.body.textContent;

describe("the privacy page (08 §5)", () => {
  it("states the minimum age and that children play through a parent's or carer's account", () => {
    render(<Privacy back="/" config={{ ...CONFIG, minAge: 16 }} />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeDefined();
    expect(text()).toContain("Family Games is for people aged 16 or older.");
    expect(text()).toContain(
      "Children under 16 can play only through a parent's or carer's account, with the parent or carer signed in.",
    );
  });

  it("gives the operator's contact", () => {
    render(<Privacy back="/" config={CONFIG} />);
    expect(text()).toContain("contact the operator of this instance at ops@example.org");
  });

  it("says the email service keeps copies, and shows the operator's retention statement as written", () => {
    const statement = "Logs are kept 14 days, backups 30 days, sent emails up to 60 days.";
    render(<Privacy back="/" config={{ ...CONFIG, privacyRetention: statement }} />);
    expect(text()).toContain(
      "The email service that sends them keeps copies of the messages it sends.",
    );
    expect(screen.getByText(statement)).toBeDefined();
  });

  it("says so when the operator hasn't stated retention, and how to ask", () => {
    render(<Privacy back="/" config={CONFIG} />);
    expect(text()).toContain(
      "The operator of this instance hasn't said how long server logs, backups and the email service's copies of sent messages are kept. You can ask them at ops@example.org.",
    );
  });

  it("names no third party, Turnstile included, until its widget ships (A21-P-6)", () => {
    render(<Privacy back="/" config={{ ...CONFIG, turnstileSiteKey: "site-key" }} />);
    expect(text()).toContain("The app loads nothing from other companies");
    expect(text()).not.toContain("Turnstile");
  });

  it("lists the suppression record, and every email sent, codes and the deletion confirmation included", () => {
    render(<Privacy back="/" config={CONFIG} />);
    expect(text()).toContain(
      "A scrambled form of an address that asked us to stop sending it invitations, or whose new account was deleted for being under the minimum age",
    );
    expect(text()).toContain("We email one-time codes (to sign in, or to delete your account)");
    expect(text()).toContain("a confirmation when an account is deleted");
    expect(text()).toContain("the invitation email we send them shows your address");
  });

  it("Back goes where it is told", () => {
    render(<Privacy back="/signin" config={CONFIG} />);
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/signin");
  });

  it("never markets the service to children", () => {
    render(<Privacy back="/" config={CONFIG} />);
    expect(text()).not.toMatch(/\bkids?\b|for children|family fun|all ages/iu);
  });
});
