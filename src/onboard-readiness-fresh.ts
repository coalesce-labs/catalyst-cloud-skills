// CTC-4744: the team's readiness verdict in the contract lasts five minutes, and the contract never
// recomputes it. Only a readiness read does. Setup asks for that read before it judges a team, so
// the end of setup and `catalyst ready` read the same current verdict.
import { normalizeBaseUrl, type CustomerConfig, type Ctx } from "./config.js";
import { loadContract, type LoadedContract } from "./contract.js";

const READ_THROUGH_TIMEOUT_MS = 30_000;

/** Ask the cloud to bring each team's verdict up to date, then read the contract past its cache.
 *  The read-through's own answer is not trusted: the contract it refreshes is the evidence. A cloud
 *  without the route, or any failure here, leaves the verdict as it was. */
export async function loadFreshTeamContract(
  ctx: Ctx,
  cfg: CustomerConfig,
  teamIds: readonly string[],
  signal?: AbortSignal,
): Promise<LoadedContract> {
  const expiry = cfg.auth ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() : 0;
  const bearer =
    cfg.key ||
    (cfg.auth && Number.isFinite(expiry) && expiry > 30_000 ? cfg.auth.accessToken : undefined);
  if (bearer)
    for (const id of new Set(teamIds)) {
      if (signal?.aborted) break;
      const deadline = AbortSignal.timeout(READ_THROUGH_TIMEOUT_MS);
      try {
        const response = await ctx.fetch(
          `${normalizeBaseUrl(cfg.baseUrl)}/api/v1/agent/tenant/readiness?team=${encodeURIComponent(id)}`,
          {
            redirect: "error",
            signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
            headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
          },
        );
        await response.body?.cancel().catch(() => {});
      } catch {
        // Unreachable or refused: the contract read below decides.
      }
    }
  return loadContract(ctx, cfg, { refresh: true, signal });
}
