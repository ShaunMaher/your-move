/**
 * The web app manifest (docs/spec/07-frontend.md §4), generated per request from configuration so a
 * prebuilt image or bundle carries no name (03 §9). The icon files are static assets of the web
 * app (`apps/web/public/icons`).
 */

/** Theme and background colours of the original placeholder icons (07 §4, §5). */
const THEME_COLOR = "#1f5f8b";
const BACKGROUND_COLOR = "#f7f7f5";

export interface ManifestNames {
  readonly appName: string;
  readonly appShortName: string;
}

/** The manifest document for the instance's names. */
export function webManifest(names: ManifestNames): Record<string, unknown> {
  return {
    name: names.appName,
    short_name: names.appShortName,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
