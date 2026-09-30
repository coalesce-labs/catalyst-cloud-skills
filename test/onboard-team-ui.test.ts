import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { createClackOnboardUi, type ClackOnboardPort } from "../src/onboard-ui.js";

function fixture(answer: string | symbol) {
  const events: string[] = [];
  const questions: Array<Parameters<ClackOnboardPort["select"]>[0]> = [];
  const signals = new EventEmitter();
  const port: ClackOnboardPort = {
    intro: () => {}, outro: () => {},
    log: { message: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    select: async question => { events.push("question"); questions.push(question); return answer; },
    isCancel: value => typeof value === "symbol",
  };
  const progress = { start: () => { events.push("start"); }, stop: () => { events.push("stop"); }, dispose: () => {} };
  const ui = createClackOnboardUi(port, { input: new PassThrough(), output: new PassThrough() }, { signals, progress });
  return { ui, events, questions, signals };
}
const options = [{ id: "team-a", key: "ENG", name: "Engineering" }, { id: "team-b", key: "OPS", name: "Operations" }];
test("Q2 stops progress and presents real registered team IDs and names once", async () => {
  const f = fixture("team-b");
  try {
    f.ui.stepStart("linear.team");
    expect(await f.ui.chooseTeam!(options)).toBe("team-b");
    expect(f.questions).toHaveLength(1);
    expect(f.questions[0].options.map(option => option.value)).toEqual(["team-a", "team-b"]);
    expect(f.questions[0].options.map(option => option.label).join(" ")).toContain("Engineering");
    expect(f.questions[0].options.map(option => option.label).join(" ")).toContain("Operations");
    expect(f.questions[0].options.some(option => /0 open|issue count/i.test(option.label))).toBe(false);
    expect(f.events[f.events.indexOf("question") - 1]).toBe("stop");
  } finally { f.ui.dispose(); }
});
test("Q2 cancellation returns no selection, aborts ownership and cleans signal listeners", async () => {
  const f = fixture(Symbol("cancel"));
  expect(await f.ui.chooseTeam!(options)).toBeNull();
  expect(f.ui.signal.aborted).toBe(true);
  expect(f.questions).toHaveLength(1);
  f.ui.dispose();
  expect(f.signals.listenerCount("SIGINT")).toBe(0);
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  expect(f.signals.listenerCount("SIGHUP")).toBe(0);
});
