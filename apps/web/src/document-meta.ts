/**
 * The instance's name reaches the page at runtime, from `/api/v1/config`, never from the build
 * (03 §9): the title, and the meta tag iOS reads for the home-screen label.
 */
export function applyAppName(appName: string, appShortName: string): void {
  document.title = appName;
  let meta = document.head.querySelector<HTMLMetaElement>(
    'meta[name="apple-mobile-web-app-title"]',
  );
  if (meta === null) {
    meta = document.createElement("meta");
    meta.name = "apple-mobile-web-app-title";
    document.head.append(meta);
  }
  meta.content = appShortName;
}
