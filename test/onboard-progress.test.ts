import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createOnboardProgress } from "../src/onboard-progress.js";

function fixture(columns?: number) {
  const output = new PassThrough() as PassThrough & { columns?: number };
  if (columns !== undefined) output.columns = columns;
  const writes: string[] = [];
  output.on("data", chunk => writes.push(String(chunk)));
  const controller = new AbortController();
  const progress = createOnboardProgress(output, controller.signal);
  return { writes, controller, progress };
}
afterEach(() => { vi.useRealTimers(); });

test("progress animates without input ownership or success claims and stop restores the cursor", () => {
  vi.useFakeTimers(); const f = fixture();
  f.progress.start("Waiting for browser approval");
  expect(f.writes.join("")).toContain("Waiting for browser approval");
  expect(f.writes.join("")).toContain("\x1b[?25l");
  const started = f.writes.length;
  vi.advanceTimersByTime(160);
  expect(f.writes.length).toBeGreaterThan(started);
  f.progress.stop();
  expect(f.writes.at(-1)).toContain("\x1b[?25h");
  expect(f.writes.join("")).not.toMatch(/✓|success|complete/i);
  const stopped = f.writes.length;
  vi.advanceTimersByTime(160);
  expect(f.writes).toHaveLength(stopped);
  f.progress.dispose();
});

test("abort clears animation and restores the cursor with no later writes", () => {
  vi.useFakeTimers(); const f = fixture();
  f.progress.start("Checking membership"); f.controller.abort();
  expect(f.writes.at(-1)).toContain("\x1b[?25h");
  const cancelled = f.writes.length;
  vi.advanceTimersByTime(500);
  f.progress.start("Must not restart");
  expect(f.writes).toHaveLength(cancelled);
  expect(vi.getTimerCount()).toBe(0);
  f.progress.dispose();
});

test("stop and dispose are idempotent and disposed progress cannot restart", () => {
  vi.useFakeTimers(); const f = fixture();
  f.progress.stop(); f.progress.start("Checking readiness"); f.progress.stop();
  const stopped = f.writes.length;
  f.progress.stop(); f.progress.dispose(); f.progress.dispose(); f.progress.start("Must not restart");
  f.controller.abort(); vi.advanceTimersByTime(160);
  expect(f.writes).toHaveLength(stopped);
  expect(vi.getTimerCount()).toBe(0);
});

test("progress confines newline and escape input to a width-bounded single line", () => {
  vi.useFakeTimers(); const f = fixture(16);
  f.progress.start("abcdefghij\n\r\x1b[31mvery long provider output");
  const rendered = f.writes.at(-1)!;
  const text = rendered.replace(/^\r\x1b\[2K./u, "");
  expect(text).not.toContain("\n");
  expect(text).not.toContain("\r");
  expect(text).not.toContain("\x1b");
  expect(Array.from(text).length).toBeLessThanOrEqual(14);
  f.progress.dispose();
});

test("replacement progress clears the old line before starting a new animation", () => {
  vi.useFakeTimers(); const f = fixture(3);
  f.progress.start("Old task"); f.progress.start("New task");
  expect(f.writes.filter(write => write.includes("\x1b[?25h"))).toHaveLength(1);
  expect(f.writes.join("")).not.toContain("Old task");
  expect(f.writes.join("")).not.toContain("New task");
  expect(vi.getTimerCount()).toBe(1);
  f.progress.dispose();
});

test("terminal failure during animation aborts its owner and prevents further timer writes", () => {
  vi.useFakeTimers();
  const output = new PassThrough();
  const controller = new AbortController();
  const originalWrite = output.write.bind(output);
  let fail = false;
  output.write = ((...args: Parameters<typeof output.write>) => {
    if (fail) throw new Error("fixture terminal disappeared");
    return originalWrite(...args);
  }) as typeof output.write;
  const progress = createOnboardProgress(output, controller.signal, () => controller.abort());
  progress.start("Waiting for browser approval");
  fail = true;
  expect(() => vi.advanceTimersByTime(80)).not.toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(() => { progress.start("Cannot restart"); progress.dispose(); vi.advanceTimersByTime(160); }).not.toThrow();
});

test("initial terminal write failure cancels progress without leaving an animation running", () => {
  vi.useFakeTimers();
  const output = new PassThrough();
  const controller = new AbortController();
  output.write = (() => { throw new Error("fixture terminal refused output"); }) as typeof output.write;
  const progress = createOnboardProgress(output, controller.signal, () => controller.abort());
  expect(() => progress.start("Checking membership")).not.toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(() => progress.dispose()).not.toThrow();
});


test("asynchronous output errors abort the owner and dispose removes only the owned listener", () => {
  vi.useFakeTimers();
  const output = new PassThrough();
  const existing = vi.fn();
  output.on("error", existing);
  const controller = new AbortController();
  const progress = createOnboardProgress(output, controller.signal, () => controller.abort());
  progress.start("Waiting for approval");
  expect(output.listenerCount("error")).toBe(2);
  output.emit("error", new Error("closed terminal"));
  expect(controller.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  progress.dispose();
  expect(output.listeners("error")).toEqual([existing]);
  expect(existing).toHaveBeenCalledTimes(1);
});
