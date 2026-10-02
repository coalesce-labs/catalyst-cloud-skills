import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "vitest";
import { openBrowserChecked } from "../src/browser.js";

// CTC-4477: login says a browser opened only when the opener ran. A container has no xdg-open,
// and xdg-open with no browser exits non-zero; both must reject so login says to open the link.
function child(after: (child: EventEmitter) => void) {
  const launched: Array<[string, readonly string[]]> = [];
  const launch = (command: string, args: readonly string[]) => {
    launched.push([command, args]);
    const process = Object.assign(new EventEmitter(), { unref: () => {} });
    setTimeout(() => after(process), 0);
    return process as unknown as ChildProcess;
  };
  return { launch, launched };
}

test("an opener that exits 0 resolves", async () => {
  const f = child((p) => p.emit("exit", 0));
  await expect(
    openBrowserChecked("https://example.dev/activate", {
      platform: "linux",
      launch: f.launch,
    }),
  ).resolves.toBeUndefined();
  expect(f.launched).toEqual([["xdg-open", ["https://example.dev/activate"]]]);
});

test.each([
  ["no opener is installed", (p: EventEmitter) => p.emit("error", new Error("ENOENT"))],
  ["the opener finds no browser", (p: EventEmitter) => p.emit("exit", 3)],
])("rejects when %s", async (_name, after) => {
  await expect(
    openBrowserChecked("https://example.dev/activate", {
      platform: "linux",
      launch: child(after).launch,
    }),
  ).rejects.toThrow("browser-unavailable");
});

test("rejects when spawning throws", async () => {
  await expect(
    openBrowserChecked("https://example.dev/activate", {
      launch: () => {
        throw new Error("spawn failed");
      },
    }),
  ).rejects.toThrow("browser-unavailable");
});

test("an opener still running after the wait counts as opened", async () => {
  await expect(
    openBrowserChecked("https://example.dev/activate", {
      platform: "linux",
      launch: child(() => {}).launch,
      waitMs: 5,
    }),
  ).resolves.toBeUndefined();
});
