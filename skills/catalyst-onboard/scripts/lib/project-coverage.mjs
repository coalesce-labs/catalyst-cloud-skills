#!/usr/bin/env node
// Shared coverage formatter used by where-am-i; --help documents its input contract.
if (process.argv.includes("--help")) {
  process.stdout.write(
    "Usage: imported by where-am-i; compares project rows with saved team stage mappings.\n",
  );
  process.exit(0);
}

/** Compare the full Catalyst project inventory with teams that actually have saved stage rows. */
export function projectCoverage(projects, teams) {
  const mappedTeamIds = new Set(
    teams
      .filter(
        (team) =>
          team &&
          (team.id ?? team.teamId) &&
          team.stages &&
          Object.keys(team.stages).length > 0,
      )
      .map((team) => team.id ?? team.teamId),
  );
  const mapped = [];
  const unmapped = [];
  for (const project of projects) {
    (mappedTeamIds.has(project.linearTeamId) ? mapped : unmapped).push(project);
  }
  return { mapped, unmapped, total: projects.length };
}

export function projectCoverageLines(projects, teams) {
  const coverage = projectCoverage(projects, teams);
  const teamById = new Map(teams.map((team) => [team.id ?? team.teamId, team]));
  const lines = [
    `${coverage.mapped.length} of your ${coverage.total} projects have their Linear team mapped.`,
  ];
  for (const project of coverage.mapped) {
    const team = teamById.get(project.linearTeamId);
    const readiness = team?.readiness ?? {};
    const bad = Array.isArray(readiness.checks)
      ? readiness.checks.filter((check) => check.state !== "pass")
      : [];
    lines.push(
      `${project.name} (${project.linearTeamKey ?? team?.teamKey ?? project.linearTeamId}): ${readiness.status ?? "unchecked"}${bad.length ? ` — ${bad.map((check) => `${check.id} ${check.state}`).join(", ")}` : ""}`,
    );
  }
  if (coverage.unmapped.length > 0) {
    lines.push(
      `These ${coverage.unmapped.length} do not: ${coverage.unmapped.map((project) => project.name).join(", ")}`,
    );
  }
  return { ...coverage, lines };
}
