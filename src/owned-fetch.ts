import type { ReadableStreamReadResult } from "node:stream/web";
/** One operation owns its entered fetches and upstream body readers until actual settlement. */
export interface OwnedFetch {
  fetch: typeof fetch;
  abort(reason: unknown): void;
  settle(): Promise<void>;
}
export function ownedFetch(
  fetchImpl: typeof fetch,
  parent: AbortSignal,
  options: { maxBodyBytes?: number } = {},
): OwnedFetch {
  const limit = options.maxBodyBytes;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error("owned_fetch_body_limit_invalid");
  const owned = new AbortController();
  const requests = new Set<Promise<Response>>();
  const bodies = new Set<Promise<void>>();
  const cleanupErrors: unknown[] = [];
  let settling = false;
  const stopped = () => owned.abort(parent.reason);
  parent.addEventListener("abort", stopped, { once: true });
  if (parent.aborted) stopped();
  const trackedFetch: typeof fetch = (input, init) => {
    if (owned.signal.aborted) return Promise.reject(owned.signal.reason);
    if (settling) return Promise.reject(new Error("owned_fetch_stopped"));
    const requestSignal = input instanceof Request ? input.signal : undefined;
    const signal = AbortSignal.any([
      owned.signal,
      ...(requestSignal ? [requestSignal] : []),
      ...(init?.signal ? [init.signal] : []),
    ]);
    if (signal.aborted) return Promise.reject(signal.reason);
    const network = new AbortController();
    const stopHeaders = () => network.abort(signal.reason);
    signal.addEventListener("abort", stopHeaders, { once: true });
    const pending = (async () => {
      let response: Response;
      try {
        response = await fetchImpl(input, {
          ...init,
          signal: network.signal,
          redirect: "error",
        });
      } finally {
        signal.removeEventListener("abort", stopHeaders);
      }
      if (!response.body) {
        if (signal.aborted) throw signal.reason;
        return response;
      }
      const reader = response.body.getReader();
      let bodyController:
        ReadableStreamDefaultController<Uint8Array> | undefined;
      let terminal = false;
      let consumed = 0;
      let completed = false;
      let enteredRead:
        Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
      let firstCancel: Promise<void> | undefined;
      let complete!: () => void;
      const joined = new Promise<void>((resolve) => {
        complete = resolve;
      });
      bodies.add(joined);
      const finish = () => {
        if (completed) return;
        completed = true;
        signal.removeEventListener("abort", aborted);
        try {
          reader.releaseLock();
        } catch (error) {
          cleanupErrors.push(error);
        }
        complete();
      };
      const cancel = (reason: unknown): Promise<void> => {
        if (firstCancel) return firstCancel;
        if (completed) return Promise.resolve();
        terminal = true;
        // Retain this FIRST promise: a second cancel can resolve before underlying IO acknowledges it.
        firstCancel = reader.cancel(reason);
        // Close/error the owned reader FIRST. Aborting native fetch first can instead error its
        // upstream stream and turn an otherwise acknowledged cancellation into a rejection.
        network.abort(reason);
        const read = enteredRead;
        void Promise.allSettled([firstCancel, ...(read ? [read] : [])]).then(
          (results) => {
            const cancellation = results[0];
            if (cancellation?.status === "rejected")
              cleanupErrors.push(cancellation.reason);
            finish();
          },
        );
        return firstCancel;
      };
      const aborted = () => {
        if (completed) return;
        terminal = true;
        // An abort is an error, never successful EOF that could publish a truncated page.
        try {
          bodyController?.error(signal.reason);
        } catch {
          /* already terminal */
        }
        void cancel(signal.reason).catch(() => {});
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        },
        async pull(controller) {
          if (terminal) return;
          const read = reader.read();
          enteredRead = read;
          try {
            const result = await read;
            if (terminal || signal.aborted) return;
            if (result.done) {
              terminal = true;
              controller.close();
              finish();
            } else {
              if (
                limit !== undefined &&
                result.value.byteLength > limit - consumed
              )
                throw new Error("owned_fetch_body_limit");
              consumed += result.value.byteLength;
              controller.enqueue(result.value);
            }
          } catch (error) {
            if (!terminal) {
              terminal = true;
              controller.error(error);
              void cancel(error).catch(() => {});
            }
          } finally {
            if (enteredRead === read) enteredRead = undefined;
          }
        },
        cancel(reason) {
          return cancel(reason);
        },
      });
      if (signal.aborted) {
        aborted();
        await joined;
        throw signal.reason;
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })();
    requests.add(pending);
    void pending.then(
      () => requests.delete(pending),
      () => requests.delete(pending),
    );
    return pending;
  };
  return {
    fetch: trackedFetch,
    abort(reason) {
      owned.abort(reason);
    },
    async settle() {
      settling = true;
      owned.abort(new Error("owned_fetch_settling"));
      // A fetch that ignores its signal stays owned. Its eventual body is cancelled before return.
      // This join does not pretend a deadline proves that non-cooperative IO has stopped.
      await Promise.allSettled([...requests]);
      await Promise.all([...bodies]);
      parent.removeEventListener("abort", stopped);
      if (cleanupErrors.length > 0)
        throw new AggregateError(cleanupErrors, "owned_fetch_cleanup_failed");
    },
  };
}
