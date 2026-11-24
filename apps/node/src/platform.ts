/**
 * The Node `Platform` (docs/spec/03-architecture.md §4): the client address from the socket or a
 * trusted proxy header (08 §4.1), the email sender for the configured provider (09 §2), and
 * per-request background work tracked until shutdown.
 */
import type { HttpBindings } from "@hono/node-server";
import {
  type AppConfig,
  coreEmailSender,
  type EmailSender,
  type Logger,
  type Platform,
  type Repositories,
  resolveClientIp,
} from "@your-move/server";

import type { NodeConfig } from "./node-config.js";

/** Hono's execution context, as `app.fetch` takes it. */
export interface ExecutionContextLike {
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
  /** The `smtp` sender, when that is the configured provider. */
  readonly smtp?: EmailSender;
}

export function createNodePlatform(options: NodePlatformOptions): Platform {
  const { nodeConfig } = options;
  return {
    repos: options.repos,
    config: options.config,
    log: options.log,
    now: options.now,
    email: coreEmailSender(options.config, options.log, options.now, options.smtp),
    clientIp: (request, env) =>
      resolveClientIp(request.headers, {
        mode: nodeConfig.trustProxy,
        // An empty address never parses, so a request without a socket is refused.
        socketAddress:
          (env as Partial<HttpBindings> | undefined)?.incoming?.socket.remoteAddress ?? "",
        hops: nodeConfig.trustProxyHops,
        trustedPeers: nodeConfig.trustProxyPeers,
      }),
  };
}
