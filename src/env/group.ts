// group.ts — merges every scanner's raw sightings by name into the three groups the ticket asks for.
// D-6: a wrangler [vars] entry is not a resource binding, but its value is committed in the repo, so
// it lands in build/test with nothing to declare. D-7: a name is deploy-only only when EVERY sighting
// of it is scoped to a job classified deploy; one non-deploy or non-job sighting pulls it into
// build/test — the stricter need wins, because a container that builds and tests still needs it.
import type { EnvEntry, EnvGroup, Finding, InventoryGroupView, RawSighting } from "./types.js";

const GROUP_ORDER: EnvGroup[] = ["build/test", "deploy-only", "bindings"];

export function groupSightings(sightings: RawSighting[]): { entries: EnvEntry[]; groups: InventoryGroupView[] } {
  const byName = new Map<string, RawSighting[]>();
  for (const s of sightings) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name)!.push(s);
  }

  const entries: EnvEntry[] = [];
  for (const [name, list] of byName) {
    const binding = list.find((s) => s.isBinding);
    const wranglerVar = list.find((s) => s.isWranglerVar);
    let group: EnvGroup;
    let needsDeclaration = true;
    let wranglerEnvironment: string | undefined;

    if (binding) {
      group = "bindings";
      wranglerEnvironment = binding.wranglerEnvironment;
    } else if (wranglerVar) {
      group = "build/test";
      needsDeclaration = false;
      wranglerEnvironment = wranglerVar.wranglerEnvironment;
    } else {
      const allJobScoped = list.every((s) => s.jobId !== undefined);
      const allDeploy = list.every((s) => s.jobDeploy === true);
      group = allJobScoped && allDeploy ? "deploy-only" : "build/test";
    }

    const localSource = resolveLocalSource(group, list);
    const found: Finding[] = list.map((s) => s.finding).sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
    entries.push({ name, group, localSource, needsDeclaration, wranglerEnvironment, found });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const groups: InventoryGroupView[] = GROUP_ORDER.map((id) => ({
    id,
    names: entries.filter((e) => e.group === id).map((e) => e.name).sort(),
  }));
  return { entries, groups };
}

function resolveLocalSource(group: EnvGroup, list: RawSighting[]): string {
  if (group === "bindings") return "Cloudflare binding";
  if (list.some((s) => s.isWranglerVar)) return "value committed in wrangler.toml — nothing to declare";
  const hasEnvShell = list.some((s) => s.localSource === ".env file or your shell");
  const hasCiSecret = list.some((s) => s.localSource === "CI secret");
  if (group === "deploy-only") return hasCiSecret ? "CI secret" : ".env file or your shell";
  return hasEnvShell ? ".env file or your shell" : hasCiSecret ? "CI secret" : list[0]!.localSource;
}
