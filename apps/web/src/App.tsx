import type { ApiClient, Schema } from "@your-move/api-client";
import { useEffect, useState } from "react";

type Health = "checking" | "ok" | "unreachable";

interface AppProps {
  readonly api: ApiClient;
}

/**
 * The M0 shell: the instance's name from `/api/v1/config` (never hard-coded, 03 §9) and the
 * server's health. The game shell replaces it from M2.
 */
export function App({ api }: AppProps) {
  const [config, setConfig] = useState<Schema<"ClientConfig"> | null>(null);
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let cancelled = false;
    void api.GET("/api/v1/config").then(
      ({ data }) => {
        if (cancelled || !data) return;
        setConfig(data);
        document.title = data.appName;
      },
      () => undefined,
    );
    void api.GET("/api/v1/health").then(
      ({ data }) => {
        if (!cancelled) setHealth(data?.ok === true ? "ok" : "unreachable");
      },
      () => {
        if (!cancelled) setHealth("unreachable");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <main className="shell">
      <h1>{config?.appName ?? " "}</h1>
      <p role="status" aria-live="polite">
        {health === "checking" && "Checking the server…"}
        {health === "ok" && "The server is up."}
        {health === "unreachable" && "The server can't be reached right now."}
      </p>
    </main>
  );
}
