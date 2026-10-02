import { expect, test } from "vitest";
import { createOnboardInterrupts } from "../src/onboard-interrupts.js";
test("first Ctrl-C skips an optional browser step; second inside two seconds stops", () => {
  let now = 0;
  const stop = new AbortController();
  const c = createOnboardInterrupts(stop, () => now);
  const signal = c.begin("github.install");
  c.waiting(true);
  c.interrupt("SIGINT");
  expect(signal.aborted).toBe(true);
  expect(stop.signal.aborted).toBe(false);
  now = 1999;
  c.begin("accounts");
  c.waiting(true);
  c.interrupt("SIGINT");
  expect(stop.signal.aborted).toBe(true);
});
test("after two seconds a new optional wait can be skipped", () => {
  let now = 0;
  const stop = new AbortController();
  const c = createOnboardInterrupts(stop, () => now);
  c.begin("github.install");
  c.waiting(true);
  c.interrupt("SIGINT");
  now = 2001;
  const next = c.begin("accounts");
  c.waiting(true);
  c.interrupt("SIGINT");
  expect(next.aborted).toBe(true);
  expect(stop.signal.aborted).toBe(false);
});
test.each(["signin", undefined] as const)(
  "Ctrl-C stops sign-in and work outside a wait (%s)",
  (id) => {
    const stop = new AbortController();
    const c = createOnboardInterrupts(stop);
    c.begin(id);
    c.waiting(true);
    c.interrupt("SIGINT");
    expect(stop.signal.aborted).toBe(true);
  },
);
test.each(["SIGTERM", "SIGHUP"] as const)(
  "%s stops even during an optional wait",
  (event) => {
    const stop = new AbortController();
    const c = createOnboardInterrupts(stop);
    c.begin("github.install");
    c.waiting(true);
    c.interrupt(event);
    expect(stop.signal.aborted).toBe(true);
  },
);
