/**
 * Minimal ambient type shims for Cloudflare Workers APIs.
 *
 * The `workers/cron/` subproject installs `@cloudflare/workers-types` in
 * its own `node_modules`, but `workers/` is excluded from the root
 * `tsconfig.json`. When `tests/workers/cron.test.ts` imports Worker
 * source modules, root-level `tsc` follows those imports transitively and
 * complains that `KVNamespace`, `R2Bucket`, `ScheduledController`, and
 * `ExecutionContext` are undeclared.
 *
 * Installing `@cloudflare/workers-types` at the root for a test-only type
 * need is a supply-chain cost we don't want, so this file supplies just
 * enough shape to satisfy the root type checker. Runtime behavior is
 * unaffected — the Cloudflare runtime provides real implementations when
 * `wrangler dev`/`deploy` runs, and the Worker's own `tsconfig.json`
 * resolves the full types package.
 *
 * Shapes are deliberately loose — if the Worker source starts leaning on
 * less-common KV/R2 methods, prefer installing the real types over
 * expanding this shim indefinitely.
 */

declare global {
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void>;
    delete(key: string): Promise<void>;
  }

  interface R2Object {
    key: string;
    uploaded: Date;
    body: ReadableStream;
  }

  interface R2Bucket {
    get(key: string): Promise<R2Object | null>;
    put(key: string, value: unknown): Promise<unknown>;
    list(opts?: { prefix?: string; limit?: number }): Promise<{
      objects: Array<{ key: string; uploaded: Date }>;
    }>;
  }

  interface ScheduledController {
    cron: string;
    scheduledTime: number;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

export {};
