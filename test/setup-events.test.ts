// setup-events.test.ts — CTC-4625: the line protocol the install engine speaks to `catalyst setup`.
// One event per line, tab-separated; an unknown or malformed line is shown as text, never dropped.
import { describe, expect, test } from "vitest";
import { parseSetupEvent, SetupEventStream } from "../src/setup-events.js";

describe("parseSetupEvent", () => {
  test("each known kind parses to its fields", () => {
    expect(parseSetupEvent("line\tCatalyst setup")).toEqual({
      kind: "line",
      text: "Catalyst setup",
    });
    expect(parseSetupEvent("line\t")).toEqual({ kind: "line", text: "" });
    expect(parseSetupEvent("row\tSystem\tLinux x86_64")).toEqual({
      kind: "row",
      label: "System",
      value: "Linux x86_64",
    });
    expect(parseSetupEvent("heading\tSetting up")).toEqual({
      kind: "heading",
      text: "Setting up",
    });
    expect(
      parseSetupEvent("plan\t4\tSign in to Catalyst\tyou approve once"),
    ).toEqual({
      kind: "plan",
      number: 4,
      title: "Sign in to Catalyst",
      text: "you approve once",
    });
    expect(parseSetupEvent("more\tsigned in")).toEqual({
      kind: "more",
      text: "signed in",
    });
    expect(parseSetupEvent("begin\t2\tAdd Catalyst skills")).toEqual({
      kind: "begin",
      number: 2,
      title: "Add Catalyst skills",
    });
    expect(
      parseSetupEvent("step\tdone\t3\tFolders\tcreated 8 folders"),
    ).toEqual({
      kind: "step",
      mark: "done",
      number: 3,
      title: "Folders",
      outcome: "created 8 folders",
    });
    expect(parseSetupEvent("detail\t~/.agents/skills: 40 skills")).toEqual({
      kind: "detail",
      text: "~/.agents/skills: 40 skills",
    });
    expect(parseSetupEvent("change\tCreated folder ~/catalyst")).toEqual({
      kind: "change",
      text: "Created folder ~/catalyst",
    });
    expect(parseSetupEvent("changes-end")).toEqual({ kind: "changes-end" });
    expect(parseSetupEvent("verdict\tok\tThis computer is ready.")).toEqual({
      kind: "verdict",
      ok: true,
      text: "This computer is ready.",
    });
    expect(
      parseSetupEvent(
        "stop\tStopped at step 2 of 7: Add Catalyst skills.\tno network\tcatalyst command.\trerun\t~/x.log\tsh install.sh",
      ),
    ).toEqual({
      kind: "stop",
      header: "Stopped at step 2 of 7: Add Catalyst skills.",
      what: "no network",
      done: "catalyst command.",
      fix: "rerun",
      log: "~/x.log",
      resume: "sh install.sh",
    });
    expect(parseSetupEvent("ask\tcontinue\tContinue?\ty")).toEqual({
      kind: "ask",
      id: "continue",
      question: "Continue?",
      fallback: "y",
    });
    expect(parseSetupEvent("signin\t600")).toEqual({
      kind: "signin",
      timeoutSeconds: 600,
    });
    expect(parseSetupEvent("note\tcli: /usr/bin/catalyst 0.15.0")).toEqual({
      kind: "note",
      text: "cli: /usr/bin/catalyst 0.15.0",
    });
  });

  test("a mark outside done, ok, warn, fail and skip is a plain line", () => {
    expect(parseSetupEvent("step\tmaybe\t3\tFolders\tx")).toEqual({
      kind: "line",
      text: "step maybe 3 Folders x",
    });
  });

  test("an unknown kind or a missing field is shown as a plain line, tabs as spaces", () => {
    expect(parseSetupEvent("sparkle\tx")).toEqual({
      kind: "line",
      text: "sparkle x",
    });
    expect(parseSetupEvent("step\tdone\tthree\tFolders\tx")).toEqual({
      kind: "line",
      text: "step done three Folders x",
    });
    expect(parseSetupEvent("plan\t4")).toEqual({
      kind: "line",
      text: "plan 4",
    });
    expect(parseSetupEvent("signin\tforever")).toEqual({
      kind: "line",
      text: "signin forever",
    });
  });

  test("a trailing carriage return is dropped", () => {
    expect(parseSetupEvent("line\thello\r")).toEqual({
      kind: "line",
      text: "hello",
    });
  });
});

describe("SetupEventStream", () => {
  test("splits chunks into whole lines and hands each one over as it completes", () => {
    const seen: string[] = [];
    const stream = new SetupEventStream((event) =>
      seen.push(JSON.stringify(event)),
    );
    stream.push("line\tone\nline\tt");
    expect(seen).toEqual([JSON.stringify({ kind: "line", text: "one" })]);
    stream.push("wo\nsignin\t5\n");
    expect(seen).toHaveLength(3);
    expect(JSON.parse(seen[2] ?? "{}")).toEqual({
      kind: "signin",
      timeoutSeconds: 5,
    });
  });

  test("end() flushes a last line with no newline", () => {
    const seen: unknown[] = [];
    const stream = new SetupEventStream((event) => seen.push(event));
    stream.push("line\tlast");
    stream.end();
    expect(seen).toEqual([{ kind: "line", text: "last" }]);
  });
});

test("every engine primitive survives one-byte chunking and final-line flush", () => {
  const wire = [
    "line\tCatalyst setup",
    "row\tThis computer\tLinux arm64",
    "heading\tThe plan",
    "plan\t4\tSign in to Catalyst\tyou approve once",
    "more\tcontinued text",
    "begin\t4\tSign in to Catalyst",
    "step\tok\t4\tSign in to Catalyst\talready signed in",
    "detail\thttps://example.com/?code=ABCD-1234",
    "change\tcreated folder",
    "changes-end",
    "verdict\tok\tcomplete",
    "stop\tStopped\tcause\tdone\tfix\tlog\tresume",
    "ask\tcontinue\tStart setup?\ty",
    "signin\t600",
    "note\tprivate diagnostic",
  ];
  const seen: unknown[] = [];
  const decoder = new SetupEventStream((event) => seen.push(event));
  for (const character of wire.join("\n")) decoder.push(character);
  decoder.end();
  expect(seen).toEqual(wire.map(parseSetupEvent));
  expect(seen.map((event) => (event as { kind: string }).kind)).toEqual([
    "line",
    "row",
    "heading",
    "plan",
    "more",
    "begin",
    "step",
    "detail",
    "change",
    "changes-end",
    "verdict",
    "stop",
    "ask",
    "signin",
    "note",
  ]);
  expect(seen[6]).toEqual({
    kind: "step",
    mark: "done",
    number: 4,
    title: "Sign in to Catalyst",
    outcome: "already signed in",
  });
});
