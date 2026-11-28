// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FACES } from "../engine/index.js";
import { Back, Face } from "./art.js";

afterEach(cleanup);

describe("the faces", () => {
  it("draw all 18, each its own shape, decorative and with a viewBox", () => {
    const drawings = new Set<string>();
    FACES.forEach((_face, id) => {
      const { container } = render(<Face id={id} />);
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 48 48");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("class")).toContain("ym-pr-art");
      // No text, title or label in a drawing: the card's button carries the name.
      expect(container.querySelector("title, text, desc")).toBeNull();
      drawings.add(container.innerHTML);
      cleanup();
    });
    expect(drawings.size).toBe(18);
  });

  it("draw nothing for an id that isn't a face", () => {
    expect(render(<Face id={18} />).container.innerHTML).toBe("");
    expect(render(<Face id={-1} />).container.innerHTML).toBe("");
  });

  it("paint with the board's classes only, never a literal colour", () => {
    FACES.forEach((_face, id) => {
      const { container } = render(<Face id={id} />);
      expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/iu);
      cleanup();
    });
  });

  it("have no bird among the faces, and the apple is drawn as body, stem and leaf only (that no bite is taken, and each shape, were reviewed by eye)", () => {
    expect(FACES.map((face) => face.name)).not.toContain("bird");
    const apple = render(<Face id={1} />).container;
    // One body and one stem and one leaf: three paths, none a second, bitten outline.
    expect(apple.querySelectorAll("path")).toHaveLength(3);
  });
});

describe("the card back", () => {
  it("is one decorative pattern", () => {
    const { container } = render(<Back />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.innerHTML).toContain("ym-pr-back");
  });
});
