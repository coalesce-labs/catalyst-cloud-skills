import type { Ctx } from "./config.js";
import {
  DaemonAuthorityError,
  readDaemonAuthority,
  type DaemonAuthorityProof,
} from "./daemon-authority.js";
import type { PersonCacheScope } from "./daemon-cache.js";
export interface DaemonAuthorityLifetime {
  readonly scope: PersonCacheScope;
  assertCurrent(): void;
  getToken(): Promise<string>;
  run(
    signal: AbortSignal,
    onFailure: (
      reason: "authentication_required" | "identity_mismatch",
    ) => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** One joined task owns fresh /me renewal; no config refresh/write or token publication shortcut.
 * An expired/changed proof aborts peers through onFailure before waiting for held reader cleanup. */
export async function createDaemonAuthorityLifetime(
  ctx: Ctx,
  parent: AbortSignal,
): Promise<DaemonAuthorityLifetime> {
  const owned = new AbortController(),
    lifetime = AbortSignal.any([parent, owned.signal]);
  let proof = await readDaemonAuthority(ctx, lifetime);
  const scope = proof.scope;
  let running: Promise<void> | undefined;
  let fault: DaemonAuthorityError | undefined;
  let report:
    | ((
        reason: "authentication_required" | "identity_mismatch",
      ) => Promise<void>)
    | undefined;
  let notice: Promise<void> | undefined;
  const failures: unknown[] = [];
  const fail = (error: DaemonAuthorityError) => {
    if (fault) return;
    fault = error;
    // Callback starts synchronously so the supervisor aborts both feeds before drain waits.
    if (report) {
      try {
        notice = report(
          error.kind === "identity"
            ? "identity_mismatch"
            : "authentication_required",
        );
      } catch (error) {
        notice = Promise.reject(error);
      }
      void notice.catch(() => {});
    }
    owned.abort(error);
  };
  const assertCurrent = () => {
    if (fault) throw fault;
    try {
      proof.assertCurrent();
    } catch (error) {
      if (error instanceof DaemonAuthorityError) fail(error);
      throw error;
    }
  };
  return {
    scope,
    assertCurrent,
    async getToken() {
      assertCurrent();
      const selected = proof;
      try {
        const token = await selected.getToken();
        // Renewal may replace proof during the await; the returned bearer still needs its own
        // ORIGINAL proof expiry, not the replacement's later authority window.
        selected.assertCurrent();
        assertCurrent();
        return token;
      } catch (error) {
        if (error instanceof DaemonAuthorityError) fail(error);
        throw error;
      }
    },
    run(signal, onFailure) {
      if (running) throw new Error("daemon_authority_already_running");
      report = onFailure;
      // An earlier synchronous cache guard may already have latched a fault before run starts.
      if (fault && !notice) {
        try {
          notice = report(
            fault.kind === "identity"
              ? "identity_mismatch"
              : "authentication_required",
          );
        } catch (error) {
          notice = Promise.reject(error);
        }
        void notice.catch(() => {});
      }
      const active = AbortSignal.any([lifetime, signal]);
      running = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expire = () => {
          if (!active.aborted)
            fail(
              new DaemonAuthorityError(
                "authentication",
                "daemon_authority_expired",
              ),
            );
        };
        const arm = () => {
          if (timer !== undefined) clearTimeout(timer);
          const remaining = proof.expiresAt - ctx.now().getTime();
          if (remaining <= 0) {
            expire();
            return;
          }
          timer = setTimeout(expire, remaining);
        };
        try {
          assertCurrent();
          arm();
          while (!active.aborted) {
            await sleep(10_000, active);
            if (active.aborted) break;
            // Old proof's timer stays armed throughout the read and its cleanup ACK.
            const fresh: DaemonAuthorityProof = await readDaemonAuthority(
              ctx,
              active,
            );
            if (active.aborted) break;
            if (JSON.stringify(fresh.scope) !== JSON.stringify(scope))
              throw new DaemonAuthorityError(
                "identity",
                "daemon_authority_changed",
              );
            fresh.assertCurrent();
            proof = fresh;
            arm();
          }
        } catch (error) {
          if (error instanceof AggregateError) {
            if (!active.aborted) {
              const primary = error.errors[0];
              fail(
                primary instanceof DaemonAuthorityError
                  ? primary
                  : new DaemonAuthorityError(
                      "authentication",
                      "daemon_authority_cleanup_failed",
                    ),
              );
            }
            failures.push(error);
            throw error;
          }
          if (!active.aborted)
            fail(
              error instanceof DaemonAuthorityError
                ? error
                : new DaemonAuthorityError(
                    "authentication",
                    "daemon_authority_unavailable",
                  ),
            );
          // Only an actual parent/owned cancellation is an ordinary requested stop. The proof
          // failure callback persists its reason; no automatic restart renews that latch.
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          if (notice) await notice;
        }
      })();
      void running.catch((error) => {
        if (!failures.includes(error)) failures.push(error);
      });
      return running;
    },
    async stop() {
      owned.abort(new Error("daemon_authority_stop"));
      if (running) await running.catch(() => {});
      if (failures.length)
        throw new AggregateError(failures, "daemon_authority_cleanup_failed");
    },
  };
}
