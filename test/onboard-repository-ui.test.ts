import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { createClackOnboardUi, type ClackOnboardPort } from "../src/onboard-ui.js";

const repositories = [{ teamId: "team-a", owner: "example", name: "one", repoId: "repo-one" }, { teamId: "team-a", owner: "example", name: "two", repoId: "repo-two" }];
function fixture(answer: string[] | symbol) {
  const questions: Array<Parameters<NonNullable<ClackOnboardPort["multiselect"]>>[0]> = [];
  const events: string[] = [];
  const port: ClackOnboardPort = { intro: () => {}, outro: () => {}, log: { message: () => {}, info: () => {}, warn: () => {}, error: () => {} }, select: async () => "stop",
    multiselect: async question => { events.push("question"); questions.push(question); return answer; }, isCancel: value => typeof value === "symbol" };
  const signals = new EventEmitter();
  const ui = createClackOnboardUi(port, { input: new PassThrough(), output: new PassThrough() }, { signals,
    progress: { start: () => { events.push("start"); }, stop: () => { events.push("stop"); }, dispose: () => {} } });
  return { ui, events, questions, signals };
}
test("Q3 uses one multiple-choice question with accessible repository names and no defaults", async () => {
  const f = fixture(["example/two"]);
  try {
    f.ui.stepStart("github.repos");
    expect(await f.ui.chooseRepositories!(repositories)).toEqual(["example/two"]);
    expect(f.questions).toHaveLength(1);
    expect(f.questions[0].options).toEqual([{ value: "example/one", label: "example/one" }, { value: "example/two", label: "example/two" }]);
    expect(f.questions[0].required).toBe(true);
    expect(f.questions[0]).not.toHaveProperty("initialValues");
    expect(f.events[f.events.indexOf("question") - 1]).toBe("stop");
  } finally { f.ui.dispose(); }
});
test("Q3 cancellation returns no choices and releases signal listeners", async () => {
  const f = fixture(Symbol("cancel"));
  expect(await f.ui.chooseRepositories!(repositories)).toBeNull();
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(f.signals.listenerCount(name)).toBe(0);
});
