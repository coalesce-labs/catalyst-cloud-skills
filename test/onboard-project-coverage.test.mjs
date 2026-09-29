import { describe, expect, test } from "vitest";
import {
  projectCoverage,
  projectCoverageLines,
} from "../skills/catalyst-onboard/scripts/lib/project-coverage.mjs";

describe("onboarding project coverage", () => {
  test("counts registry projects, not just the contract's mapped teams, and names every unmapped project", () => {
    const projects = Array.from({ length: 17 }, (_, index) => ({
      name: `Project ${index + 1}`,
      linearTeamId: `team-${index + 1}`,
      linearTeamKey: `T${index + 1}`,
    }));
    const teams = Array.from({ length: 6 }, (_, index) => ({
      id: `team-${index + 1}`,
      stages: { dispatch: { stateId: `state-${index + 1}` } },
      readiness: { status: "ready", checks: [] },
    }));

    const report = projectCoverage(projects, teams);
    expect(report).toMatchObject({
      total: 17,
      mapped: projects.slice(0, 6),
      unmapped: projects.slice(6),
    });
    const rendered = projectCoverageLines(projects, teams).lines.join("\n");
    expect(rendered).toContain(
      "6 of your 17 projects have their Linear team mapped.",
    );
    expect(rendered).toContain(
      "These 11 do not: Project 7, Project 8, Project 9, Project 10, Project 11, Project 12, Project 13, Project 14, Project 15, Project 16, Project 17",
    );
  });

  test("a config row without any saved stages does not count as mapped", () => {
    const result = projectCoverage(
      [{ name: "Project", linearTeamId: "team-1" }],
      [{ id: "team-1", stages: {} }],
    );
    expect(result.mapped).toEqual([]);
    expect(result.unmapped).toHaveLength(1);
  });
});
