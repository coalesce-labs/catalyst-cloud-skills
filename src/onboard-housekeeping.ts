import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Ctx } from "./config.js";
import type { OnboardAdapter, OnboardStepResult } from "./onboard.js";

/** The names install.sh schedules the daily update under (catalyst-cloud's install-script.ts). */
export const HOUSEKEEPING_LABEL = "dev.catalystcloud.housekeeping";
export const HOUSEKEEPING_TIMER = "catalyst-housekeeping.timer";

export type SchedulerRun = (
  cmd: string,
  args: string[],
) => { status: number; stdout: string; stderr: string };
export interface HousekeepingOptions {
  platform?: NodeJS.Platform;
  run?: SchedulerRun;
  uid?: number;
}

const defaultRun: SchedulerRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5_000 });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.error ? r.error.message : (r.stderr ?? ""),
  };
};
function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, name), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}
/** The installer's own test for "systemctl is here but nothing manages user services". */
const NO_USER_MANAGER =
  /failed to connect to bus: (no medium found|no such file or directory)|system has not been booted with systemd/i;
/** Every answer but "scheduled" is a skip: the daily update is optional, so it never holds setup
 * or becomes its next action. The reason keeps which case it is. */
const skipped = (reason: string, path?: string): OnboardStepResult => ({
  state: "skipped",
  reason,
  ...(path ? { evidence: { path } } : {}),
});

/** CTC-4680: the daily update step reports what this computer actually has. It only observes:
 * scheduling stays the installer's job. */
export function onboardHousekeepingAdapter(
  options: HousekeepingOptions = {},
): OnboardAdapter {
  const run = options.run ?? defaultRun;
  return {
    check: async (ctx: Ctx, journal) => {
      const platform = options.platform ?? process.platform;
      const choice = journal.dailyUpdate;
      const notChosen = (): OnboardStepResult | undefined =>
        choice?.state === "off"
          ? skipped("housekeeping_off_chosen")
          : choice?.state === "skipped"
            ? skipped("housekeeping_no_scheduler")
            : undefined;
      if (platform === "darwin") {
        if (!onPath("launchctl", ctx.env))
          return notChosen() ?? skipped("housekeeping_no_scheduler");
        const plist = join(
          ctx.home,
          "Library",
          "LaunchAgents",
          `${HOUSEKEEPING_LABEL}.plist`,
        );
        if (!existsSync(plist))
          return notChosen() ?? skipped("housekeeping_not_scheduled");
        const uid = options.uid ?? process.getuid?.() ?? 0;
        // `print` answers for a loaded job only; the plist alone schedules nothing.
        if (run("launchctl", ["print", `gui/${uid}/${HOUSEKEEPING_LABEL}`]).status === 0)
          return {
            state: "done",
            evidence: { scheduled: true, provider: "launchd", path: plist },
          };
        return notChosen() ?? skipped("housekeeping_not_loaded", plist);
      }
      if (platform === "linux") {
        if (!onPath("systemctl", ctx.env))
          return notChosen() ?? skipped("housekeeping_no_scheduler");
        const timer = join(
          ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"),
          "systemd",
          "user",
          HOUSEKEEPING_TIMER,
        );
        if (existsSync(timer)) {
          const enabled = run("systemctl", ["--user", "is-enabled", HOUSEKEEPING_TIMER]);
          if (enabled.status === 0 && enabled.stdout.trim() === "enabled")
            return {
              state: "done",
              evidence: { scheduled: true, provider: "systemd", path: timer },
            };
          if (NO_USER_MANAGER.test(enabled.stderr))
            return notChosen() ?? skipped("housekeeping_no_scheduler");
          return notChosen() ?? skipped("housekeeping_not_enabled", timer);
        }
        const chosen = notChosen();
        if (chosen) return chosen;
        // A systemctl binary is not a scheduler: a container or WSL has it with no user manager.
        const manager = run("systemctl", ["--user", "show-environment"]);
        return manager.status !== 0 && NO_USER_MANAGER.test(manager.stderr)
          ? skipped("housekeeping_no_scheduler")
          : skipped("housekeeping_not_scheduled");
      }
      return notChosen() ?? skipped("housekeeping_no_scheduler");
    },
  };
}
