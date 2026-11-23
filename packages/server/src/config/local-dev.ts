const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Local-dev mode (docs/spec/06-auth.md §4): enabled only when the parsed `PUBLIC_URL` has scheme
 * `http` and host exactly `localhost`, `127.0.0.1` or `[::1]`. This predicate is the only switch
 * for every dev behaviour (`console` email, the non-`__Host-` cookie, `/__dev/*` routes).
 */
export function isLocalDevUrl(publicUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
}

/** {@link isLocalDevUrl} for a parsed configuration. */
export function isLocalDev(config: { readonly publicUrl: string }): boolean {
  return isLocalDevUrl(config.publicUrl);
}

/**
 * The `APP_SECRET` committed in `config/local-dev.env` so a fresh clone runs with no setup. It is
 * public, so the config parser refuses it unless local-dev mode is on.
 */
export const LOCAL_DEV_APP_SECRET = "bG9jYWwtZGV2LW9ubHktbm90LWEtc2VjcmV0LWRvLW5vdC11c2U=";
