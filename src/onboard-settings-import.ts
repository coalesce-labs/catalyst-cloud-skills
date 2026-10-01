import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import {
  createSelectedImportWriter,
  type SelectedImportKind,
} from "./env/selected-import-writer.js";
import type { SelectedNameImportWriter } from "./env/selected-import.js";
import type {
  SettingsAuthorityContext,
  SettingsAuthorityPorts,
} from "./env/settings-authority.js";

const uncertain = () => new Error("selected import outcome uncertain");
const bind = (context: SettingsAuthorityContext) =>
  JSON.stringify([
    context.accountId,
    context.personId,
    context.baseUrl,
    context.role,
    context.teamId,
    context.teamKey,
    context.repoId,
    context.repoName,
    context.repoRoot,
  ]);

/** The review boundary owns declaration authority. Each actual write additionally rechecks
 * current access and identity; neither the disk contract nor the receipt supplies a scope. */
export function createOnboardSettingsWriter(input: {
  ctx: Ctx;
  context: SettingsAuthorityContext;
  ports: SettingsAuthorityPorts;
  kind: SelectedImportKind;
  signal?: AbortSignal;
}): SelectedNameImportWriter {
  const expected = { ...input.context };
  const binding = bind(expected);
  try {
    const url = new URL(expected.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.origin !== expected.baseUrl ||
      !["owner", "admin"].includes(expected.role)
    )
      throw uncertain();
  } catch {
    throw uncertain();
  }
  const post = async (path: string, body: unknown) => {
    const owned = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, owned.signal])
      : owned.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let remove = () => {};
    try {
      return await new Promise<{ status: number; body: unknown }>(
        (resolve, reject) => {
          const stopped = () => reject(uncertain());
          if (signal.aborted) {
            stopped();
            return;
          }
          signal.addEventListener("abort", stopped, { once: true });
          remove = () => signal.removeEventListener("abort", stopped);
          timer = setTimeout(() => owned.abort(), 30_000);
          Promise.resolve()
            .then(async () => {
              const current = await input.ports.readContext(signal);
              if (!current || bind(current) !== binding || signal.aborted)
                throw uncertain();
              const cfg = loadConfig(input.ctx.home);
              if (
                !cfg?.user ||
                cfg.account !== expected.accountId ||
                cfg.user.id !== expected.personId ||
                normalizeBaseUrl(cfg.baseUrl) !== expected.baseUrl ||
                !["owner", "admin"].includes(cfg.user.role)
              )
                throw uncertain();
              const expiry = cfg.auth
                ? Date.parse(cfg.auth.expiresAt) - input.ctx.now().getTime()
                : 0;
              const bearer =
                cfg.key ||
                (cfg.auth && Number.isFinite(expiry) && expiry > 30_000
                  ? cfg.auth.accessToken
                  : undefined);
              if (!bearer || signal.aborted) throw uncertain();
              const supported = await verifyOnboardRoutes(
                input.ctx,
                {
                  account: expected.accountId,
                  tenant: expected.accountId,
                  membershipId: expected.personId,
                  baseUrl: expected.baseUrl,
                },
                [{ method: "POST", path }],
                signal,
              );
              if ("reason" in supported || signal.aborted) throw uncertain();
              const response = await input.ctx.fetch(
                `${expected.baseUrl}${path}`,
                {
                  method: "POST",
                  redirect: "error",
                  signal,
                  headers: {
                    authorization: `Bearer ${bearer}`,
                    accept: "application/json",
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(body),
                },
              );
              // Refusal bodies may contain unsafe text. The adapter needs their status only.
              const result = {
                status: response.status,
                body: response.ok
                  ? ((await response.json()) as unknown)
                  : undefined,
              };
              if (signal.aborted) throw uncertain();
              return result;
            })
            .then(
              (value) => (signal.aborted ? stopped() : resolve(value)),
              () => reject(uncertain()),
            );
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
      remove();
    }
  };
  const writer = createSelectedImportWriter({
    kind: input.kind,
    writeVariable: (name, value) =>
      post("/me/env-vars", {
        scope: "repo",
        repoId: expected.repoId,
        name,
        value,
      }),
    importSecrets: (text) =>
      post("/me/secrets/import", {
        repo: expected.repoName,
        text,
        rotateExisting: [],
        source: "onboarding selected import",
      }),
  });
  return async (text, names) => {
    const result = await writer(text, names);
    return { writtenNames: result.written, failedNames: result.failed };
  };
}
