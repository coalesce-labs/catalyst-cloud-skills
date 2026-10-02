import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { firstTicketIntent } from "../src/onboard-first-ticket.js";
import { createClackOnboardUi, type ClackOnboardPort } from "../src/onboard-ui.js";

const intent = firstTicketIntent({ account: "account-a", person: "person-a", origin: "https://tenant.example",
  teamId: "team-a", teamKey: "TEAM", repoId: "repo-a", repoName: "example/docs",
  dispatchStateId: "state-dispatch", starter: "contributing-tests" }, "run-a:first-ticket")!;
function fixture(answer: string | symbol | Promise<string>) {
  const events: string[] = [], selections: Array<Parameters<ClackOnboardPort["select"]>[0]> = [];
  const port: ClackOnboardPort = {
    intro() {}, outro() {},
    log: { message: text => { events.push(text); }, info() {}, warn() {}, error() {} },
    select: async options => { selections.push(options); events.push("PROMPT"); return answer; },
    isCancel: value => typeof value === "symbol",
  };
  const ui = createClackOnboardUi(port, { input: new PassThrough(), output: new PassThrough() }, {
    signals: new EventEmitter(), progress: { start: () => { events.push("SPIN"); }, stop: () => { events.push("STOP"); }, dispose() {} },
  });
  return { ui, events, selections };
}

test("Q5 displays the complete exact documentation proposal before one explicit Start selection", async () => {
  const f = fixture("start"); f.ui.stepStart("first-ticket");
  expect(await f.ui.approveFirstTicket!(intent, new AbortController().signal)).toBe(true);
  expect(f.selections).toHaveLength(1);
  expect(f.selections[0]!.initialValue).toBe("later");
  expect(f.selections[0]!.options.map(row => row.value)).toEqual(["start", "later"]);
  expect(f.events.indexOf("STOP")).toBeLessThan(f.events.indexOf("PROMPT"));
  expect(f.events).toContain("First ticket for TEAM in example/docs");
  expect(f.events).toContain("Document how to run repository tests");
  expect(f.events).toContain("Update only CONTRIBUTING.md to document existing test commands from repository configuration. Do not change executable code, configuration, dependencies, or credentials. If the test commands cannot be established from source, stop and report the missing information.");
  expect(f.events.indexOf(intent.description)).toBeLessThan(f.events.indexOf("PROMPT"));
  f.ui.dispose();
});
test("Q5 Later declines only the first ticket and keeps setup available", async () => {
  const f = fixture("later");
  expect(await f.ui.approveFirstTicket!(intent, new AbortController().signal)).toBe(false);
  expect(f.ui.signal.aborted).toBe(false); expect(f.selections).toHaveLength(1); f.ui.dispose();
});
test("Q5 cancellation aborts through the receipt engine signal", async () => {
  const f = fixture(Symbol("cancel"));
  expect(await f.ui.approveFirstTicket!(intent, new AbortController().signal)).toBe(false);
  expect(f.ui.signal.aborted).toBe(true); f.ui.dispose();
});
test("Q5 refuses a changed proposal with a retained old approval hash before displaying it", async () => {
  const f = fixture("start");
  expect(await f.ui.approveFirstTicket!({ ...intent, repoName: "example/other" }, new AbortController().signal)).toBe(false);
  expect(f.selections).toEqual([]); expect(f.events).toEqual([]); f.ui.dispose();
});
test("Q5 does not ask or accept Start after an already aborted caller", async () => {
  const f = fixture("start"), stop = new AbortController(); stop.abort();
  expect(await f.ui.approveFirstTicket!(intent, stop.signal)).toBe(false);
  expect(f.selections).toEqual([]); f.ui.dispose();
});
test("Q5 late Start after caller cancellation cannot become approval", async () => {
  let resolve!: (answer: string) => void;
  const answer = new Promise<string>(done => { resolve = done; });
  const f = fixture(answer), stop = new AbortController();
  const pending = f.ui.approveFirstTicket!(intent, stop.signal);
  expect(f.selections).toHaveLength(1); stop.abort();
  expect(f.selections[0]!.signal.aborted).toBe(true); resolve("start");
  expect(await pending).toBe(false); f.ui.dispose();
});

test.each([
  { title: "Change executable code" }, { description: "Install dependencies and expose credentials" },
  { schema: 2 }, { phase: "implement" }, { extra: "unapproved" },
])("Q5 refuses noncanonical intent fields before displaying a question %#", async mutation => {
  const f = fixture("start"), changed = { ...intent };
  Object.assign(changed, mutation);
  expect(await f.ui.approveFirstTicket!(changed, new AbortController().signal)).toBe(false);
  expect(f.selections).toEqual([]); expect(f.events).toEqual([]); f.ui.dispose();
});
