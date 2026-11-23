/**
 * Node-only configuration (docs/spec/09-operations.md §1, 08 §4.1). Parsed by its own Zod schema
 * alongside the framework schema; messages name the variable and rule, never a value.
 */
import { isIP } from "node:net";

import { ConfigError, type Env } from "@your-move/server";
import { z } from "zod";

/** The fallback `TRUST_PROXY_PEERS`: private ranges and loopback (08 §4.1). */
export const DEFAULT_TRUST_PROXY_PEERS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
  "127.0.0.0/8",
  "::1/128",
] as const;

export interface NodeConfig {
  readonly port: number;
  readonly databasePath: string;
  readonly blobDir: string;
  readonly trustProxy: "false" | "xff" | "cloudflare";
  readonly trustProxyHops: number;
  readonly trustProxyPeers: readonly string[];
  /** True when `TRUST_PROXY_PEERS` was not set and the broad default applies (startup warns). */
  readonly trustProxyPeersDefaulted: boolean;
  readonly allowOrphanGames: boolean;
}

/** Whether `value` is an IPv4 or IPv6 CIDR block such as `172.30.99.0/28` or `fc00::/7`. */
export function isCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split("/");
  if (address === undefined || prefix === undefined || rest.length > 0) return false;
  if (!/^\d{1,3}$/u.test(prefix)) return false;
  const version = isIP(address);
  const bits = Number(prefix);
  return (version === 4 && bits <= 32) || (version === 6 && bits <= 128);
}

const integer = (min: number, max: number, rule: string) =>
  z
    .string()
    .regex(/^\d+$/u, { error: rule })
    .transform(Number)
    .refine((value) => value >= min && value <= max, { error: rule });

const nodeSchema = z.looseObject({
  PORT: integer(1, 65_535, "must be a port number between 1 and 65535").optional(),
  DATABASE_PATH: z.string().min(1).optional(),
  BLOB_DIR: z.string().min(1).optional(),
  TRUST_PROXY: z
    .enum(["false", "xff", "cloudflare"], { error: "must be false, xff or cloudflare" })
    .optional(),
  TRUST_PROXY_HOPS: integer(1, 32, "must be a whole number between 1 and 32").optional(),
  TRUST_PROXY_PEERS: z
    .string()
    .refine((value) => value.split(",").every((entry) => isCidr(entry.trim())), {
      error: "must be a comma-separated list of CIDR blocks",
    })
    .optional(),
  ALLOW_ORPHAN_GAMES: z.enum(["true", "false"], { error: "must be true or false" }).optional(),
});

/** Parses the Node-only variables. Empty values count as unset. */
export function parseNodeConfig(env: Env): NodeConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = nodeSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `${String(issue.path[0] ?? "(environment)")}: ${issue.message}`,
      ),
    );
  }
  const raw = result.data;
  return {
    port: raw.PORT ?? 8080,
    databasePath: raw.DATABASE_PATH ?? "/data/app.sqlite",
    blobDir: raw.BLOB_DIR ?? "/data/blobs",
    trustProxy: raw.TRUST_PROXY ?? "false",
    trustProxyHops: raw.TRUST_PROXY_HOPS ?? 1,
    trustProxyPeers: raw.TRUST_PROXY_PEERS?.split(",").map((entry) => entry.trim()) ?? [
      ...DEFAULT_TRUST_PROXY_PEERS,
    ],
    trustProxyPeersDefaulted: raw.TRUST_PROXY_PEERS === undefined,
    allowOrphanGames: raw.ALLOW_ORPHAN_GAMES === "true",
  };
}
