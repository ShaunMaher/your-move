/**
 * Test setup for the jsdom component tests: jsdom has no constructable stylesheets, which the
 * board needs (styles.ts), so give it enough of them to adopt a sheet.
 */
if (typeof document !== "undefined" && !("adoptedStyleSheets" in document)) {
  Object.defineProperty(document, "adoptedStyleSheets", {
    value: [],
    writable: true,
    configurable: true,
  });
  class Sheet {
    replaceSync(): void {
      // The component tests don't read styles.
    }
  }
  Object.defineProperty(globalThis, "CSSStyleSheet", {
    value: Sheet,
    writable: true,
    configurable: true,
  });
}
