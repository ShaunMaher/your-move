/**
 * Icon sanitisation (docs/spec/02-game-framework.md §7.2, §7.3): a manifest icon is SVG markup the
 * app renders, so it is checked against a strict allow-list rather than cleaned. Allowed: basic
 * shapes, groups, gradients and clip paths, presentation attributes, and `url(#id)` references to
 * the icon's own ids. Refused: scripts, event handlers, `style` (CSS can fetch), links and any
 * `href`, `foreignObject`, entities, comments, CDATA, processing instructions and DOCTYPEs, and
 * anything over 16384 characters.
 */

const MAX_LENGTH = 16 * 1024;

const ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
]);

/** Elements whose content may be text (an accessible name), never markup. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(["title", "desc"]);

const ATTRIBUTES: ReadonlySet<string> = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "id",
  "role",
  "aria-label",
  "aria-hidden",
  "focusable",
  "d",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-miterlimit",
  "opacity",
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "preserveAspectRatio",
]);

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NAME = /^[A-Za-z][A-Za-z0-9-]*$/u;
/** One tag: `<name attrs>`, `<name attrs/>` or `</name>`. */
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s=<>"'/]+\s*=\s*"[^"<>]*")*)\s*(\/?)>/guy;
const ATTRIBUTE = /\s+([^\s=<>"'/]+)\s*=\s*"([^"<>]*)"/guy;

/** Problems with an attribute's value: only `url(#id)` references, no schemes, no entities. */
function valueProblems(name: string, value: string): string[] {
  const problems: string[] = [];
  if (value.includes("&")) problems.push(`${name}: character references are not allowed`);
  if (/[a-z][a-z0-9+.-]*:/iu.test(value) && name !== "xmlns") {
    problems.push(`${name}: values must not contain a URL scheme`);
  }
  for (const match of value.matchAll(/url\(([^)]*)\)/giu)) {
    if (!/^#[A-Za-z][\w-]*$/u.test(match[1] ?? "")) {
      problems.push(`${name}: only url(#id) references to the icon's own ids are allowed`);
    }
  }
  if (name === "xmlns" && value !== SVG_NAMESPACE) {
    problems.push(`xmlns must be ${SVG_NAMESPACE}`);
  }
  return problems;
}

/**
 * Every reason `svg` isn't an acceptable manifest icon; empty when it is.
 *
 * @public
 */
export function checkIcon(svg: string): string[] {
  if (svg.trim() === "") return ["is empty"];
  if (svg.length > MAX_LENGTH) return ["is longer than 16384 characters"];
  const problems: string[] = [];
  const open: string[] = [];
  let index = 0;
  let root = 0;
  const source = svg.trim();
  while (index < source.length) {
    const next = source.indexOf("<", index);
    const text = source.slice(index, next === -1 ? source.length : next);
    if (text.trim() !== "") {
      const parent = open.at(-1);
      if (parent === undefined || !TEXT_ELEMENTS.has(parent)) {
        problems.push("text is allowed only inside <title> and <desc>");
      } else if (/[&>]/u.test(text)) {
        problems.push("text must not contain character references or '>'");
      }
    }
    if (next === -1) break;
    TAG.lastIndex = next;
    const tag = TAG.exec(source);
    if (tag === null) {
      problems.push(
        `unrecognised markup at offset ${String(next)} (comments, CDATA, DOCTYPE and entities are not allowed)`,
      );
      break;
    }
    const [, closing, name = "", attributes = "", selfClosing] = tag;
    index = TAG.lastIndex;
    if (!ELEMENTS.has(name)) {
      problems.push(`<${name}> is not an allowed element`);
      continue;
    }
    if (closing === "/") {
      if (attributes !== "" || selfClosing === "/") problems.push(`malformed </${name}>`);
      if (open.pop() !== name) problems.push(`</${name}> doesn't close the open element`);
      continue;
    }
    if (open.length === 0) {
      root += 1;
      if (name !== "svg") problems.push("the root element must be <svg>");
    } else if (TEXT_ELEMENTS.has(open.at(-1) ?? "")) {
      problems.push(`<${open.at(-1) ?? ""}> may contain only text`);
    }
    ATTRIBUTE.lastIndex = 0;
    const seen = new Set<string>();
    for (const [, attribute = "", value = ""] of attributes.matchAll(ATTRIBUTE)) {
      if (!NAME.test(attribute) || !ATTRIBUTES.has(attribute)) {
        problems.push(`attribute ${attribute} is not allowed`);
        continue;
      }
      if (seen.has(attribute)) problems.push(`attribute ${attribute} is repeated`);
      seen.add(attribute);
      problems.push(...valueProblems(attribute, value));
    }
    if (selfClosing !== "/") open.push(name);
  }
  if (open.length > 0) problems.push(`<${open.join("> <")}> not closed`);
  if (root !== 1) problems.push("must have exactly one root <svg> element");
  return [...new Set(problems)];
}
