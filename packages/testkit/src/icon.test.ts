import { describe, expect, it } from "vitest";

import { checkIcon } from "./icon.js";

const svg = (body: string, attrs = ""): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${attrs}>${body}</svg>`;

describe("checkIcon", () => {
  it.each([
    ["basic shapes", svg('<circle cx="12" cy="12" r="10" fill="#36c"/><path d="M0 0L24 24"/>')],
    [
      "a gradient referenced by id",
      svg(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="24" height="24" fill="url(#g)"/>',
      ),
    ],
    ["a title", svg('<title>Cards</title><g><rect x="1" y="1" width="2" height="2"/></g>')],
    ["surrounding whitespace", `\n  ${svg("<g/>")}\n`],
  ])("accepts %s", (_name, icon) => {
    expect(checkIcon(icon)).toEqual([]);
  });

  it.each([
    ["an empty icon", "  ", /is empty/u],
    ["a huge icon", svg(`<path d="${"M0 0".repeat(5000)}"/>`), /longer than/u],
    ["a script", svg("<script>alert(1)</script>"), /<script> is not an allowed element/u],
    ["an event handler", svg('<rect onclick="x()"/>'), /onclick is not allowed/u],
    ["a style attribute", svg('<rect style="fill:red"/>'), /style is not allowed/u],
    ["a link", svg('<a href="https://example.org"><rect/></a>'), /<a> is not an allowed element/u],
    ["an href", svg('<use href="#x"/>'), /<use> is not an allowed element/u],
    ["foreignObject", svg("<foreignObject/>"), /foreignObject/u],
    [
      "an external url()",
      svg('<rect fill="url(https://example.org/x)"/>'),
      /URL scheme|url\(#id\)/u,
    ],
    ["a javascript: value", svg('<rect fill="javascript:x"/>'), /URL scheme/u],
    ["a character reference", svg('<rect fill="&#106;"/>'), /character references/u],
    ["a comment", svg("<!-- hi -->"), /unrecognised markup/u],
    ["a DOCTYPE", `<!DOCTYPE svg>${svg("")}`, /unrecognised markup/u],
    ["CDATA", svg("<title><![CDATA[x]]></title>"), /unrecognised markup/u],
    [
      "single-quoted attributes",
      "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      /unrecognised markup/u,
    ],
    ["a wrong namespace", '<svg xmlns="http://example.org/"></svg>', /xmlns must be/u],
    ["a non-svg root", '<g xmlns="http://www.w3.org/2000/svg"></g>', /root element must be <svg>/u],
    ["two roots", `${svg("")}${svg("")}`, /exactly one root/u],
    ["text outside title", svg("hello"), /text is allowed only inside/u],
    ["text after the root", `${svg("")}trailing`, /text is allowed only inside/u],
    ["markup inside title", svg("<title><rect/></title>"), /may contain only text/u],
    ["an entity in a title", svg("<title>a &amp; b</title>"), /character references/u],
    ["an unclosed element", '<svg xmlns="http://www.w3.org/2000/svg"><g>', /not closed/u],
    ["a mismatched close", svg("<g></rect>"), /doesn't close/u],
    ["a malformed close", svg('<g></g x="1">'), /unrecognised markup|malformed/u],
    ["a repeated attribute", svg('<rect x="1" x="2"/>'), /repeated/u],
  ])("refuses %s", (_name, icon, problem) => {
    expect(checkIcon(icon).join("\n")).toMatch(problem);
  });
});
