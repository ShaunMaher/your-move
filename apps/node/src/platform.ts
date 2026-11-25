/**
 * The Node `Platform` (docs/spec/03-architecture.md §4): the client address from the socket or a
 * trusted proxy header (08 §4.1), the email sender for the configured provider (09 §2), and
 * per-request background work tracked until shutdown.
 */
import { BlockList, isIP } from "node:net";

import type { HttpBindings } from "@hono/node-server";
import {
  type AppConfig,
  type BuiltinDictionaries,
  coreEmailSender,
  type EmailSender,
  type Logger,
  type Platform,
  type Repositories,
  resolveClientIp,
} from "@your-move/server";

import type { NodeConfig } from "./node-config.js";

/** Hono's execution context, as `app.fetch` takes it. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  props: unknown;
}

/**
 * Background work of every request, so shutdown can wait for it (the Node side of `waitUntil`,
 * 03 §4). Each request gets its own context; all share the one set of pending tasks.
 */
export interface BackgroundTracker {
  context(): ExecutionContextLike;
  /** Settles once every task started so far has finished. */
  drain(): Promise<void>;
}

export function createBackgroundTracker(): BackgroundTracker {
  const pending = new Set<Promise<unknown>>();
  return {
    context() {
      return {
        waitUntil(promise) {
          const tracked = promise.then(
            () => undefined,
            () => undefined,
          );
          pending.add(tracked);
          void tracked.then(() => pending.delete(tracked));
        },
        passThroughOnException() {
          // Not applicable outside Workers.
        },
        props: {},
      };
    },
    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

export interface NodePlatformOptions {
  readonly repos: Repositories;
  readonly config: AppConfig;
  readonly nodeConfig: Pick<NodeConfig, "trustProxy" | "trustProxyHops" | "trustProxyPeers">;
  readonly log: Logger;
  readonly now: () => Date;
  readonly dictionaries: BuiltinDictionaries;
  /** The `smtp` sender, when that is the configured provider. */
  readonly smtp?: EmailSender;
}

/** How many client addresses the misconfigured-proxy check looks at (08 §4.1). */
export const PROXY_CHECK_WINDOW = 100;

const PRIVATE = new BlockList();
for (const [network, prefix, type] of [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["fc00::", 7, "ipv6"],
  ["::1", 128, "ipv6"],
] as const) {
  PRIVATE.addSubnet(network, prefix, type);
}

function isPrivate(address: string): boolean {
  const plain = address.replace(/^::ffff:/iu, "");
  const type = isIP(plain);
  return type !== 0 && PRIVATE.check(plain, type === 4 ? "ipv4" : "ipv6");
}

/**
 * With `TRUST_PROXY=false`, warns once when the last {@link PROXY_CHECK_WINDOW} client addresses
 * were all private or loopback: most likely a proxy in front that isn't configured, which would put
 * every user in one rate-limit bucket (08 §4.1).
 */
function proxyMisconfigurationCheck(log: Logger): (address: string) => void {
  let privateInARow = 0;
  let warned = false;
  return (address) => {
    if (warned) return;
    privateInARow = isPrivate(address) ? privateInARow + 1 : 0;
    if (privateInARow >= PROXY_CHECK_WINDOW) {
      warned = true;
      log.warn(
        "every recent client address is private or loopback: is a proxy in front without TRUST_PROXY set?",
        { recentAddresses: PROXY_CHECK_WINDOW },
      );
    }
  };
}

export function createNodePlatform(options: NodePlatformOptions): Platform {
  const { nodeConfig } = options;
  const check = proxyMisconfigurationCheck(options.log);
  return {
    repos: options.repos,
    config: options.config,
    log: options.log,
    now: options.now,
    dictionaries: options.dictionaries,
    email: coreEmailSender(options.config, options.log, options.now, options.smtp),
    clientIp: (request, env) => {
      // An empty address never parses, so a request without a socket is refused.
      const socketAddress =
        (env as Partial<HttpBindings> | undefined)?.incoming?.socket.remoteAddress ?? "";
      if (nodeConfig.trustProxy === "false" && socketAddress !== "") check(socketAddress);
      return resolveClientIp(request.headers, {
        mode: nodeConfig.trustProxy,
        socketAddress,
        hops: nodeConfig.trustProxyHops,
        trustedPeers: nodeConfig.trustProxyPeers,
      });
    },
  };
}
