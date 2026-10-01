// packages/environment/src/validation-helpers.ts
class EnvironmentContractError extends TypeError {
  reason;
  constructor(message, reason) {
    super(`invalid repo environment declaration: ${message}`);
    this.name = "EnvironmentContractError";
    if (reason !== undefined)
      this.reason = reason;
  }
}
var PROVENANCE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closedRecord(value, allowedFields, path) {
  if (!isRecord(value))
    throw new EnvironmentContractError(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new EnvironmentContractError(`unknown field ${JSON.stringify(`${path}.${key}`)}`);
    }
  }
  return value;
}
function enumValue(value, allowed, path) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new EnvironmentContractError(`${path} must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  return value;
}
function boundedArray(value, path, maximum) {
  if (!Array.isArray(value))
    throw new EnvironmentContractError(`${path} must be an array`);
  if (value.length > maximum) {
    throw new EnvironmentContractError(`${path} must contain at most ${maximum} items`);
  }
  return value;
}
function boundedString(value, path, re, maxLength, describe) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !re.test(value)) {
    throw new EnvironmentContractError(`${path} must be ${describe}`);
  }
  return value;
}
function boundedInteger(value, path, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new EnvironmentContractError(`${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function sortedUnique(values, key) {
  const byKey = new Map;
  for (const value of values)
    byKey.set(key(value), value);
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}
var PRINTABLE_RE = /^[\x21-\x7E ]+$/;
function validateRelativePath(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new EnvironmentContractError(`${path} must be a non-empty path of at most 512 characters`);
  }
  if (value.startsWith("/") || value.startsWith("\\")) {
    throw new EnvironmentContractError(`${path} must not be an absolute path`);
  }
  if (value.split(/[\\/]/).includes("..")) {
    throw new EnvironmentContractError(`${path} must not contain ".." path segments`);
  }
  if (!PRINTABLE_RE.test(value)) {
    throw new EnvironmentContractError(`${path} must contain only printable characters`);
  }
  return value;
}
function validateProvenanceIdRefs(value, path, knownIds) {
  return sortedUnique(boundedArray(value, path, 16).map((entry, i) => {
    const id = boundedString(entry, `${path}[${i}]`, PROVENANCE_ID_RE, 64, "a lowercase kebab-case provenance id");
    if (!knownIds.has(id)) {
      throw new EnvironmentContractError(`${path}[${i}] references unknown provenance id ${JSON.stringify(id)}`);
    }
    return id;
  }), (id) => id);
}

// packages/environment/src/provenance.ts
var CONFIDENCES = ["high", "medium", "low"];
var PROVENANCE_FIELDS = new Set([
  "id",
  "kind",
  "path",
  "lineStart",
  "lineEnd",
  "confidence",
  "explanation"
]);
var KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;
var EXPLANATION_RE = /^[\s\S]{1,512}$/;
var MAX_LINE = 1e6;
function validateProvenanceRecord(value, path) {
  const raw = closedRecord(value, PROVENANCE_FIELDS, path);
  const id = boundedString(raw.id, `${path}.id`, PROVENANCE_ID_RE, 64, "a lowercase kebab-case identifier of at most 64 characters");
  const kind = boundedString(raw.kind, `${path}.kind`, KIND_RE, 64, "a lowercase kebab-case identifier of at most 64 characters");
  const recordPath = validateRelativePath(raw.path, `${path}.path`);
  const confidence = enumValue(raw.confidence, CONFIDENCES, `${path}.confidence`);
  const explanation = boundedString(raw.explanation, `${path}.explanation`, EXPLANATION_RE, 512, "a value-free explanation of at most 512 characters");
  let lineStart;
  let lineEnd;
  if (raw.lineStart !== undefined) {
    lineStart = boundedInteger(raw.lineStart, `${path}.lineStart`, 1, MAX_LINE);
  }
  if (raw.lineEnd !== undefined) {
    lineEnd = boundedInteger(raw.lineEnd, `${path}.lineEnd`, 1, MAX_LINE);
  }
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    throw new EnvironmentContractError(`${path}.lineEnd must be >= ${path}.lineStart`);
  }
  return {
    id,
    kind,
    path: recordPath,
    ...lineStart !== undefined ? { lineStart } : {},
    ...lineEnd !== undefined ? { lineEnd } : {},
    confidence,
    explanation
  };
}

// packages/environment/src/secret-material.ts
var SECRET_ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*(?:_TOKEN|_SECRET|_KEY|_PASSWORD|_CREDENTIAL)|TOKEN|SECRET|PASSWORD)=(\S{4,})/;
var AUTH_KEY_RE = /(^authorization$|api[-_]?key$|_token$|_secret$|_key$|_password$|_credential$|^token$|^secret$|^password$)/i;
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var TOKEN_START_SEPARATOR_CLASS = `[\\s=:,;"'/?&@]`;
function mixedBody(chars, min) {
  return `(?=[${chars}]*[0-9])(?=[${chars}]*[A-Z])[${chars}]{${min},}`;
}
var SECRET_TOKEN_SHAPES = [
  {
    kind: "GitHub token",
    prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    source: "(gh[pousr]_)[A-Za-z0-9]{36,}"
  },
  { kind: "GitHub token", prefixes: ["github_pat_"], source: "(github_pat_)[A-Za-z0-9_]{22,}" },
  {
    kind: "Stripe key",
    prefixes: ["sk_live_", "sk_test_"],
    source: "(sk_(?:live|test)_)[A-Za-z0-9]{16,}"
  },
  {
    kind: "OpenAI-style API key",
    prefixes: ["sk-"],
    source: `(sk-)${mixedBody("A-Za-z0-9", 32)}`
  },
  {
    kind: "OpenAI-style API key",
    prefixes: ["sk-"],
    source: `(sk-)(?:proj|svcacct|admin)-${mixedBody("A-Za-z0-9_-", 40)}`
  },
  {
    kind: "Anthropic API key",
    prefixes: ["sk-"],
    source: `(sk-)ant-(?:api|admin|oat)\\d{2}-${mixedBody("A-Za-z0-9_-", 40)}`
  },
  {
    kind: "Slack token",
    prefixes: ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"],
    source: "(xox[bpars]-)(?=[0-9])[A-Za-z0-9-]{10,}"
  },
  {
    kind: "AWS access key",
    prefixes: ["AKIA", "ASIA"],
    source: "(AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])"
  },
  { kind: "Google API key", prefixes: ["AIza"], source: "(AIza)[0-9A-Za-z_-]{35}" },
  {
    kind: "private key",
    prefixes: ["-----BEGIN"],
    source: "(-----BEGIN) [A-Z ]*PRIVATE KEY(?: BLOCK)?-----"
  }
];
var SECRET_TOKEN_RES = SECRET_TOKEN_SHAPES.map((shape) => ({
  kind: shape.kind,
  re: new RegExp(`(?:^|${TOKEN_START_SEPARATOR_CLASS})${shape.source}`)
}));
function secretTokenIn(value) {
  let best = null;
  for (const { kind, re } of SECRET_TOKEN_RES) {
    const m = re.exec(value);
    if (m === null)
      continue;
    const index = m.index + m[0].indexOf(m[1]);
    if (best === null || index < best.index)
      best = { kind, prefix: m[1], index };
  }
  return best === null ? null : { kind: best.kind, prefix: best.prefix };
}
function secretTokenMessage(path, kind) {
  return `${path} looks like ${/^[AEIOU]/.test(kind) ? "an" : "a"} ${kind}; ` + "declarations name secrets, they never hold them. " + "Store the value as a repository secret (Settings → Repositories → the repository → Environment → Secrets).";
}
var PERSONAL_GITHUB_TOKEN_PREFIXES = [
  "ghp_",
  "gho_",
  "ghu_",
  "ghr_",
  "github_pat_"
];
var PERSONAL_TOKEN_START_RE = new RegExp(`(?:^|${TOKEN_START_SEPARATOR_CLASS})(${PERSONAL_GITHUB_TOKEN_PREFIXES.map(escapeRegExp).join("|")})`);

// packages/environment/src/agent-assets.ts
var AGENT_ASSET_KINDS = ["skill", "mcp-server", "cli"];
var AGENT_ASSET_HARNESSES = ["claude", "codex", "opencode"];
var TIERS = ["platform", "repository", "tenant-channel"];
var SKILL_FIELDS = new Set([
  "kind",
  "id",
  "tier",
  "reference",
  "digest",
  "requiredEnvNames",
  "provenanceIds"
]);
var MCP_STDIO_FIELDS = new Set([
  "kind",
  "id",
  "transport",
  "command",
  "args",
  "env",
  "requiredEnvNames",
  "harnesses",
  "provenanceIds"
]);
var MCP_HTTP_FIELDS = new Set([
  "kind",
  "id",
  "transport",
  "url",
  "headers",
  "requiredEnvNames",
  "harnesses",
  "provenanceIds"
]);
var MCP_PORTAL_FIELDS = new Set([
  "kind",
  "id",
  "transport",
  "via",
  "requiredEnvNames",
  "harnesses",
  "provenanceIds"
]);
var CLI_FIELDS = new Set(["kind", "id", "install", "provenanceIds"]);
var CLI_IMAGE_FIELDS = new Set(["source"]);
var CLI_NPM_FIELDS = new Set(["source", "package", "version"]);
var ID_RE = /^[a-z][a-z0-9._-]{0,127}$/;
var TOOL_ID_MAX = 64;
var TOOL_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
function carriesReference(value) {
  return value.includes("$") || value.includes("{env:");
}
var DIGEST_RE = /^[0-9a-f]{64}$/;
var ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var REFERENCE_RE = /^[\x21-\x7E ]{1,512}$/;
var VAULT_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
var WHOLE_REF_RE = /^\$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))$/;
var BEARER_REF_RE = /^Bearer \$(?:\{([A-Z][A-Z0-9_]*)\}|([A-Z][A-Z0-9_]*))$/;
var COMMAND_RE = /^[\x21-\x7E]{1,512}$/;
var ARG_RE = /^[\x20-\x7E]{1,1024}$/;
var URL_RE = /^https?:\/\/[\x21-\x7E]{1,2040}$/;
var HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-_]{0,127}$/;
var LITERAL_RE = /^[\x20-\x7E]{0,1024}$/;
var NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
var NPM_VERSION_RE = /^[A-Za-z0-9^~<>=][A-Za-z0-9.+_\-^~<>=*]{0,63}$/;
var MAX_ARGS = 64;
var MAX_MAP_ENTRIES = 32;
var NON_PORTABLE_AUTH_KEYS = [
  "auth",
  "oauth",
  "authorization_server",
  "keychain",
  "keyring",
  "oauth_client_id",
  "client_id"
];
var AUTH_NOT_PORTABLE_MESSAGE = "a browser OAuth session or an OS keyring cannot be carried into a container; declare the " + "server's token/API-key mode with the key stored as a vault secret and referenced as $NAME in " + "headers (http) or listed in requiredEnvNames (stdio), or use a stdio server whose command reads " + "its auth from env";
function agentAssetKey(entry) {
  return `${entry.kind}:${entry.id}`;
}
function refNameOf(value) {
  const match = WHOLE_REF_RE.exec(value) ?? BEARER_REF_RE.exec(value);
  return match ? match[1] ?? match[2] ?? null : null;
}
function looksLikeSecretValue(key, value) {
  if (refNameOf(value) !== null)
    return false;
  if (secretTokenIn(value) !== null)
    return true;
  return AUTH_KEY_RE.test(key) && value.length >= 4;
}
function refuse(message, reason) {
  throw new EnvironmentContractError(message, reason);
}
function tagged(reason, run) {
  try {
    return run();
  } catch (err) {
    if (err instanceof EnvironmentContractError && err.reason === undefined) {
      throw new EnvironmentContractError(err.message.replace(/^invalid repo environment declaration: /, ""), reason);
    }
    throw err;
  }
}
function stringMap(value, path, keyRe, describeKey) {
  if (!isRecord(value))
    refuse(`${path} must be an object`, "invalid_shape");
  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_ENTRIES) {
    refuse(`${path} must contain at most ${MAX_MAP_ENTRIES} entries`, "invalid_shape");
  }
  const out = {};
  for (const [key, item] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!keyRe.test(key))
      refuse(`${path} key ${JSON.stringify(key)} must be ${describeKey}`, "invalid_shape");
    if (typeof item !== "string" || !LITERAL_RE.test(item)) {
      refuse(`${path}.${key} must be a printable string of at most 1024 characters`, "invalid_shape");
    }
    out[key] = item;
  }
  return out;
}
function vaultNames(value, path) {
  const names = tagged("invalid_shape", () => boundedArray(value, path, MAX_MAP_ENTRIES)).map((entry, i) => {
    if (typeof entry !== "string" || entry.length > 128 || !VAULT_NAME_RE.test(entry)) {
      refuse(`${path}[${i}] must be a vault secret name matching ^[A-Z][A-Z0-9_]*$`, "invalid_reference");
    }
    return entry;
  });
  return sortedUnique(names, (name) => name);
}
function toolId(value, path) {
  return tagged("invalid_name", () => boundedString(value, path, TOOL_ID_RE, TOOL_ID_MAX, `a lowercase identifier of at most ${TOOL_ID_MAX} characters without "."`));
}
function validateSkill(raw, path, known) {
  tagged("invalid_shape", () => closedRecord(raw, SKILL_FIELDS, path));
  const id = tagged("invalid_name", () => boundedString(raw.id, `${path}.id`, ID_RE, 128, "a lowercase identifier of at most 128 characters"));
  return tagged("invalid_shape", () => {
    const tier = enumValue(raw.tier, TIERS, `${path}.tier`);
    const reference = tier === "repository" ? validateRelativePath(raw.reference, `${path}.reference`) : boundedString(raw.reference, `${path}.reference`, REFERENCE_RE, 512, "a printable reference of at most 512 characters");
    let digest;
    if (raw.digest !== undefined) {
      digest = boundedString(raw.digest, `${path}.digest`, DIGEST_RE, 64, "lowercase hexadecimal ([0-9a-f]{64})");
    }
    if (tier === "repository" && digest === undefined) {
      throw new EnvironmentContractError(`${path}.digest is required for tier "repository"`);
    }
    const requiredEnvNames = sortedUnique(boundedArray(raw.requiredEnvNames, `${path}.requiredEnvNames`, 32).map((entry, i) => boundedString(entry, `${path}.requiredEnvNames[${i}]`, ENV_NAME_RE, 128, "an environment variable name")), (name) => name);
    const provenanceIds = validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, known);
    return {
      kind: "skill",
      id,
      tier,
      reference,
      ...digest !== undefined ? { digest } : {},
      requiredEnvNames,
      provenanceIds
    };
  });
}
function validateUrl(value, path) {
  if (typeof value !== "string" || !URL_RE.test(value)) {
    refuse(`${path} must be an http(s) URL of at most 2048 printable characters`, "invalid_shape");
  }
  if (carriesReference(value)) {
    refuse(`${path} must not carry a reference; put the credential in a header as $NAME`, "invalid_reference");
  }
  const query = value.indexOf("?");
  if (query !== -1) {
    for (const pair of value.slice(query + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1)
        continue;
      if (looksLikeSecretValue(pair.slice(0, eq), pair.slice(eq + 1))) {
        refuse(`${path} carries a credential-shaped query parameter ${JSON.stringify(pair.slice(0, eq))}; ` + "store the value as a vault secret and send it as a header referencing $NAME", "literal_secret");
      }
    }
  }
  if (secretTokenIn(value) !== null) {
    refuse(`${path} appears to contain a live credential; declarations carry names, never values`, "literal_secret");
  }
  return value;
}
function validateHeaders(value, path) {
  const headers = stringMap(value, path, HEADER_NAME_RE, "an HTTP header name");
  for (const [name, headerValue] of Object.entries(headers)) {
    const at = `${path}.${name}`;
    if (WHOLE_REF_RE.test(headerValue))
      continue;
    if (BEARER_REF_RE.test(headerValue)) {
      if (name.toLowerCase() === "authorization")
        continue;
      refuse(`${at}: "Bearer $NAME" is accepted on Authorization only; use a whole $NAME here`, "invalid_reference");
    }
    if (carriesReference(headerValue)) {
      refuse(`${at} must be a literal, a whole $NAME / \${NAME} reference, or "Bearer $NAME" on Authorization ` + "(names match ^[A-Z][A-Z0-9_]*$)", "invalid_reference");
    }
    if (looksLikeSecretValue(name, headerValue)) {
      refuse(`${at} looks like a credential literal; store it as a vault secret and reference it as $NAME`, "literal_secret");
    }
  }
  return headers;
}
function validateLiteralEnv(value, path) {
  const env = stringMap(value, path, ENV_NAME_RE, "an environment variable name");
  for (const [name, literal] of Object.entries(env)) {
    if (carriesReference(literal)) {
      refuse(`${path}.${name} must be a literal; a secret the server reads is listed in requiredEnvNames under ` + "its own name and passed through, never renamed", "env_reference_must_match_key");
    }
    if (looksLikeSecretValue(name, literal)) {
      refuse(`${path}.${name} looks like a credential literal; store it as a vault secret and list it in requiredEnvNames`, "literal_secret");
    }
  }
  return env;
}
function validateMcpServer(raw, path, known) {
  const transport = tagged("invalid_shape", () => enumValue(raw.transport, ["stdio", "http"], `${path}.transport`));
  const via = raw.via;
  if (via !== undefined && (via !== "portal" || transport !== "http")) {
    refuse(`${path}.via must be "portal" on an http server`, "invalid_shape");
  }
  tagged("invalid_shape", () => closedRecord(raw, transport === "stdio" ? MCP_STDIO_FIELDS : via === "portal" ? MCP_PORTAL_FIELDS : MCP_HTTP_FIELDS, path));
  const id = toolId(raw.id, `${path}.id`);
  let harnesses;
  if (raw.harnesses !== undefined) {
    harnesses = tagged("invalid_shape", () => {
      const list = boundedArray(raw.harnesses, `${path}.harnesses`, AGENT_ASSET_HARNESSES.length).map((h, i) => enumValue(h, AGENT_ASSET_HARNESSES, `${path}.harnesses[${i}]`));
      if (list.length === 0)
        throw new EnvironmentContractError(`${path}.harnesses must not be empty (omit it for all)`);
      return sortedUnique(list, (h) => h);
    });
  }
  const provenanceIds = tagged("invalid_shape", () => validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, known));
  if (transport === "stdio") {
    const command = tagged("invalid_shape", () => boundedString(raw.command, `${path}.command`, COMMAND_RE, 512, "a printable executable of at most 512 characters"));
    let args;
    if (raw.args !== undefined) {
      args = tagged("invalid_shape", () => boundedArray(raw.args, `${path}.args`, MAX_ARGS).map((arg, i) => boundedString(arg, `${path}.args[${i}]`, ARG_RE, 1024, "a printable argument of at most 1024 characters")));
    }
    for (const [at, value] of [
      [`${path}.command`, command],
      ...(args ?? []).map((arg, i) => [`${path}.args[${i}]`, arg])
    ]) {
      if (carriesReference(value)) {
        refuse(`${at} must be literal; a secret the server reads is listed in requiredEnvNames and read ` + "from its environment", "invalid_reference");
      }
    }
    const env = raw.env === undefined ? undefined : validateLiteralEnv(raw.env, `${path}.env`);
    const requiredEnvNames = vaultNames(raw.requiredEnvNames, `${path}.requiredEnvNames`);
    for (const name of requiredEnvNames) {
      if (env && name in env) {
        refuse(`${path}.env.${name} is also in requiredEnvNames; a name is either passed through or literal`, "invalid_shape");
      }
    }
    return {
      kind: "mcp-server",
      id,
      transport,
      command,
      ...args !== undefined ? { args } : {},
      ...env !== undefined ? { env } : {},
      requiredEnvNames,
      ...harnesses !== undefined ? { harnesses } : {},
      provenanceIds
    };
  }
  if (raw.requiredEnvNames !== undefined && !(Array.isArray(raw.requiredEnvNames) && raw.requiredEnvNames.length === 0)) {
    refuse(`${path}.requiredEnvNames must be empty for an http server; its auth is a header referencing $NAME`, "invalid_shape");
  }
  if (via === "portal") {
    return {
      kind: "mcp-server",
      id,
      transport: "http",
      via: "portal",
      requiredEnvNames: [],
      ...harnesses !== undefined ? { harnesses } : {},
      provenanceIds
    };
  }
  const url = validateUrl(raw.url, `${path}.url`);
  const headers = raw.headers === undefined ? undefined : validateHeaders(raw.headers, `${path}.headers`);
  return {
    kind: "mcp-server",
    id,
    transport,
    url,
    ...headers !== undefined ? { headers } : {},
    requiredEnvNames: [],
    ...harnesses !== undefined ? { harnesses } : {},
    provenanceIds
  };
}
function validateCli(raw, path, known) {
  tagged("invalid_shape", () => closedRecord(raw, CLI_FIELDS, path));
  const id = toolId(raw.id, `${path}.id`);
  const install = tagged("invalid_shape", () => {
    const installPath = `${path}.install`;
    if (!isRecord(raw.install))
      throw new EnvironmentContractError(`${installPath} must be an object`);
    const source = enumValue(raw.install.source, ["image", "npm"], `${installPath}.source`);
    if (source === "image") {
      closedRecord(raw.install, CLI_IMAGE_FIELDS, installPath);
      return { source };
    }
    const npm = closedRecord(raw.install, CLI_NPM_FIELDS, installPath);
    const pkg = boundedString(npm.package, `${installPath}.package`, NPM_NAME_RE, 214, "an npm package name");
    if (npm.version === undefined)
      return { source, package: pkg };
    const version = boundedString(npm.version, `${installPath}.version`, NPM_VERSION_RE, 64, "an npm version, tag or single range without spaces");
    return { source, package: pkg, version };
  });
  const provenanceIds = tagged("invalid_shape", () => validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, known));
  return { kind: "cli", id, install, provenanceIds };
}
function validateAgentAssetEntry(value, path, knownProvenanceIds) {
  if (!isRecord(value))
    refuse(`${path} must be an object`, "invalid_shape");
  for (const key of NON_PORTABLE_AUTH_KEYS) {
    if (key in value)
      refuse(`${path}.${key}: ${AUTH_NOT_PORTABLE_MESSAGE}`, "auth_not_portable");
  }
  const kind = tagged("invalid_shape", () => enumValue(value.kind, AGENT_ASSET_KINDS, `${path}.kind`));
  switch (kind) {
    case "skill":
      return validateSkill(value, path, knownProvenanceIds);
    case "mcp-server":
      return validateMcpServer(value, path, knownProvenanceIds);
    case "cli":
      return validateCli(value, path, knownProvenanceIds);
  }
}
function assertNoSecretMaterialInAgentAssets(agentAssets) {
  agentAssets.forEach((asset, i) => {
    const at = `agentAssets[${i}]`;
    const scan = (value, path) => {
      const assignment = SECRET_ASSIGNMENT_RE.exec(value);
      if (assignment) {
        refuse(`${path} appears to contain an inline secret assignment (${assignment[1]}=...); ` + "declarations may reference environment/secret NAMES only, never values", "literal_secret");
      }
      const token = secretTokenIn(value);
      if (token !== null)
        refuse(secretTokenMessage(path, token.kind), "literal_secret");
    };
    switch (asset.kind) {
      case "skill":
        scan(asset.reference, `${at}.reference`);
        return;
      case "mcp-server":
        if (asset.command !== undefined)
          scan(asset.command, `${at}.command`);
        asset.args?.forEach((arg, j) => scan(arg, `${at}.args[${j}]`));
        if (asset.url !== undefined)
          scan(asset.url, `${at}.url`);
        for (const [name, value] of Object.entries(asset.headers ?? {})) {
          if (looksLikeSecretValue(name, value)) {
            refuse(`${at}.headers.${name} looks like a credential literal`, "literal_secret");
          }
        }
        for (const [name, value] of Object.entries(asset.env ?? {})) {
          if (looksLikeSecretValue(name, value)) {
            refuse(`${at}.env.${name} looks like a credential literal`, "literal_secret");
          }
        }
        return;
      case "cli":
        if (asset.install.source === "npm")
          scan(asset.install.package, `${at}.install.package`);
        return;
    }
  });
}

// packages/environment/src/contract.ts
var TOP_LEVEL_FIELDS = new Set([
  "version",
  "toolchains",
  "systemPackages",
  "setup",
  "verify",
  "services",
  "environment",
  "agentAssets",
  "provenance"
]);
var TOOLCHAIN_FIELDS = new Set(["name", "version", "provenanceIds"]);
var SYSTEM_PACKAGE_FIELDS = new Set(["name", "version", "provenanceIds"]);
var EXECUTABLE_STEP_FIELDS = new Set([
  "id",
  "command",
  "cwd",
  "timeoutSeconds",
  "rerunWhenChanged",
  "provenanceIds"
]);
var SERVICE_FIELDS = new Set(["name", "image", "readiness", "provenanceIds"]);
var SERVICE_READINESS_COMMAND_FIELDS = new Set(["kind", "command", "timeoutSeconds"]);
var SERVICE_READINESS_PORT_FIELDS = new Set(["kind", "port"]);
var ENVIRONMENT_NAME_FIELDS = new Set(["name", "required", "secret", "provenanceIds"]);
var DECLARATION_NAME_RE = /^[a-z][a-z0-9+._-]{0,63}$/;
var DECLARATION_VERSION_RE = /^[A-Za-z0-9^~*<>=][A-Za-z0-9.+_\-^~*<>=| ]{0,63}$/;
var STEP_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
var ENV_NAME_RE2 = /^[A-Za-z_][A-Za-z0-9_]*$/;
var IMAGE_RE = /^[\x21-\x7E]{1,256}$/;
var MAX_TOOLCHAINS = 32;
var MAX_SYSTEM_PACKAGES = 128;
var MAX_STEPS = 64;
var MAX_SERVICES = 16;
var MAX_ENV_REFS = 128;
var MAX_AGENT_ASSETS = 64;
var MAX_PROVENANCE = 512;
var MAX_ARGV_LENGTH = 64;
var MAX_ARGV_ITEM_LENGTH = 1024;
var MAX_RERUN_ENTRIES = 64;
var MAX_RERUN_ENTRY_LENGTH = 256;
var MIN_TIMEOUT_SECONDS = 1;
var MAX_TIMEOUT_SECONDS = 3600;
function validateCommandArgv(value, path) {
  const arr = boundedArray(value, path, MAX_ARGV_LENGTH);
  if (arr.length === 0)
    throw new EnvironmentContractError(`${path} must contain at least one argument`);
  return arr.map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_ARGV_ITEM_LENGTH) {
      throw new EnvironmentContractError(`${path}[${i}] must be a non-empty string of at most ${MAX_ARGV_ITEM_LENGTH} characters`);
    }
    return entry;
  });
}
function validateToolchainEntry(value, path, knownProvenanceIds) {
  const raw = closedRecord(value, TOOLCHAIN_FIELDS, path);
  const name = boundedString(raw.name, `${path}.name`, DECLARATION_NAME_RE, 64, "a lowercase identifier of at most 64 characters");
  const version = boundedString(raw.version, `${path}.version`, DECLARATION_VERSION_RE, 64, "a version string of at most 64 characters");
  const provenanceIds = validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, knownProvenanceIds);
  return { name, version, provenanceIds };
}
function validateSystemPackageEntry(value, path, knownProvenanceIds) {
  const raw = closedRecord(value, SYSTEM_PACKAGE_FIELDS, path);
  const name = boundedString(raw.name, `${path}.name`, DECLARATION_NAME_RE, 64, "a lowercase identifier of at most 64 characters");
  let version;
  if (raw.version !== undefined) {
    version = boundedString(raw.version, `${path}.version`, DECLARATION_VERSION_RE, 64, "a version string of at most 64 characters");
  }
  const provenanceIds = validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, knownProvenanceIds);
  return { name, ...version !== undefined ? { version } : {}, provenanceIds };
}
function validateRerunWhenChanged(value, path) {
  const arr = boundedArray(value, path, MAX_RERUN_ENTRIES);
  if (arr.length === 0) {
    throw new EnvironmentContractError(`${path} must contain at least one entry`);
  }
  const entries = arr.map((entry, i) => {
    const entryPath = `${path}[${i}]`;
    const validated = validateRelativePath(entry, entryPath);
    if (validated.length > MAX_RERUN_ENTRY_LENGTH) {
      throw new EnvironmentContractError(`${entryPath} must be at most ${MAX_RERUN_ENTRY_LENGTH} characters`);
    }
    return validated;
  });
  return sortedUnique(entries, (entry) => entry);
}
function validateExecutableStep(value, path, knownProvenanceIds) {
  const raw = closedRecord(value, EXECUTABLE_STEP_FIELDS, path);
  const id = boundedString(raw.id, `${path}.id`, STEP_ID_RE, 64, "a lowercase kebab-case identifier of at most 64 characters");
  const command = validateCommandArgv(raw.command, `${path}.command`);
  let cwd;
  if (raw.cwd !== undefined)
    cwd = validateRelativePath(raw.cwd, `${path}.cwd`);
  const timeoutSeconds = boundedInteger(raw.timeoutSeconds, `${path}.timeoutSeconds`, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  let rerunWhenChanged;
  if (raw.rerunWhenChanged !== undefined) {
    rerunWhenChanged = validateRerunWhenChanged(raw.rerunWhenChanged, `${path}.rerunWhenChanged`);
  }
  const provenanceIds = validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, knownProvenanceIds);
  return {
    id,
    command,
    ...cwd !== undefined ? { cwd } : {},
    timeoutSeconds,
    ...rerunWhenChanged !== undefined ? { rerunWhenChanged } : {},
    provenanceIds
  };
}
function validateServiceReadiness(value, path) {
  if (!isRecord(value))
    throw new EnvironmentContractError(`${path} must be an object`);
  if (value.kind === "command") {
    const raw = closedRecord(value, SERVICE_READINESS_COMMAND_FIELDS, path);
    const command = validateCommandArgv(raw.command, `${path}.command`);
    const timeoutSeconds = boundedInteger(raw.timeoutSeconds, `${path}.timeoutSeconds`, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
    return { kind: "command", command, timeoutSeconds };
  }
  if (value.kind === "port") {
    const raw = closedRecord(value, SERVICE_READINESS_PORT_FIELDS, path);
    const port = boundedInteger(raw.port, `${path}.port`, 1, 65535);
    return { kind: "port", port };
  }
  throw new EnvironmentContractError(`${path}.kind must be one of "command", "port"`);
}
function validateServiceEntry(value, path, knownProvenanceIds) {
  const raw = closedRecord(value, SERVICE_FIELDS, path);
  const name = boundedString(raw.name, `${path}.name`, DECLARATION_NAME_RE, 64, "a lowercase identifier of at most 64 characters");
  let image;
  if (raw.image !== undefined) {
    image = boundedString(raw.image, `${path}.image`, IMAGE_RE, 256, "a printable image reference of at most 256 characters");
  }
  const readiness = validateServiceReadiness(raw.readiness, `${path}.readiness`);
  const provenanceIds = validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, knownProvenanceIds);
  return { name, ...image !== undefined ? { image } : {}, readiness, provenanceIds };
}
function validateEnvironmentNameRef(value, path, knownProvenanceIds) {
  const raw = closedRecord(value, ENVIRONMENT_NAME_FIELDS, path);
  const name = boundedString(raw.name, `${path}.name`, ENV_NAME_RE2, 128, "an environment variable name");
  if (typeof raw.required !== "boolean") {
    throw new EnvironmentContractError(`${path}.required must be a boolean`);
  }
  let secret;
  if (raw.secret !== undefined) {
    if (typeof raw.secret !== "boolean") {
      throw new EnvironmentContractError(`${path}.secret must be a boolean`);
    }
    secret = raw.secret;
  }
  const provenanceIds = validateProvenanceIdRefs(raw.provenanceIds, `${path}.provenanceIds`, knownProvenanceIds);
  return {
    name,
    required: raw.required,
    ...secret !== undefined ? { secret } : {},
    provenanceIds
  };
}
function assertUniqueStepIds(steps, path) {
  const seen = new Set;
  for (const step of steps) {
    if (seen.has(step.id))
      throw new EnvironmentContractError(`${path} contains duplicate id ${JSON.stringify(step.id)}`);
    seen.add(step.id);
  }
}
function assertUniqueServiceNames(services) {
  const seen = new Set;
  for (const service of services) {
    if (seen.has(service.name)) {
      throw new EnvironmentContractError(`services contains duplicate name ${JSON.stringify(service.name)}`);
    }
    seen.add(service.name);
  }
}
function scanForSecretMaterial(value, path) {
  const assignmentMatch = SECRET_ASSIGNMENT_RE.exec(value);
  if (assignmentMatch) {
    throw new EnvironmentContractError(`${path} appears to contain an inline secret assignment (${assignmentMatch[1]}=...); ` + "declarations may reference environment/secret NAMES only, never values");
  }
  const token = secretTokenIn(value);
  if (token !== null)
    throw new EnvironmentContractError(secretTokenMessage(path, token.kind));
}
function assertNoSecretMaterial(declaration) {
  const scanStep = (step, path) => {
    step.command.forEach((arg, i) => scanForSecretMaterial(arg, `${path}.command[${i}]`));
  };
  declaration.setup.forEach((step, i) => scanStep(step, `setup[${i}]`));
  declaration.verify.forEach((step, i) => scanStep(step, `verify[${i}]`));
  declaration.services.forEach((service, i) => {
    if (service.readiness.kind === "command") {
      service.readiness.command.forEach((arg, j) => scanForSecretMaterial(arg, `services[${i}].readiness.command[${j}]`));
    }
    if (service.image !== undefined)
      scanForSecretMaterial(service.image, `services[${i}].image`);
  });
  assertNoSecretMaterialInProvenance(declaration.provenance);
  assertNoSecretMaterialInAgentAssets(declaration.agentAssets);
}
function assertNoSecretMaterialInProvenance(provenance) {
  provenance.forEach((record, i) => scanForSecretMaterial(record.explanation, `provenance[${i}].explanation`));
}
function validateProvenanceList(value) {
  const rawProvenance = boundedArray(value, "provenance", MAX_PROVENANCE);
  const rawProvenanceIds = rawProvenance.map((entry) => isRecord(entry) ? entry.id : undefined);
  if (new Set(rawProvenanceIds).size !== rawProvenanceIds.length) {
    throw new EnvironmentContractError("provenance ids must be unique");
  }
  const provenance = sortedUnique(rawProvenance.map((entry, i) => validateProvenanceRecord(entry, `provenance[${i}]`)), (p) => p.id);
  return provenance;
}
function validateRepoEnvironmentDeclaration(input) {
  const raw = closedRecord(input, TOP_LEVEL_FIELDS, "declaration");
  if (raw.version !== 1) {
    throw new EnvironmentContractError(`version must be exactly 1 (got ${JSON.stringify(raw.version)})`);
  }
  const provenance = validateProvenanceList(raw.provenance);
  const knownProvenanceIds = new Set(provenance.map((p) => p.id));
  const toolchains = sortedUnique(boundedArray(raw.toolchains, "toolchains", MAX_TOOLCHAINS).map((entry, i) => validateToolchainEntry(entry, `toolchains[${i}]`, knownProvenanceIds)), (t) => t.name);
  const systemPackages = sortedUnique(boundedArray(raw.systemPackages, "systemPackages", MAX_SYSTEM_PACKAGES).map((entry, i) => validateSystemPackageEntry(entry, `systemPackages[${i}]`, knownProvenanceIds)), (p) => p.name);
  const setup = boundedArray(raw.setup, "setup", MAX_STEPS).map((entry, i) => validateExecutableStep(entry, `setup[${i}]`, knownProvenanceIds));
  assertUniqueStepIds(setup, "setup");
  const verify = boundedArray(raw.verify, "verify", MAX_STEPS).map((entry, i) => validateExecutableStep(entry, `verify[${i}]`, knownProvenanceIds));
  assertUniqueStepIds(verify, "verify");
  const services = boundedArray(raw.services, "services", MAX_SERVICES).map((entry, i) => validateServiceEntry(entry, `services[${i}]`, knownProvenanceIds));
  assertUniqueServiceNames(services);
  const environment = sortedUnique(boundedArray(raw.environment, "environment", MAX_ENV_REFS).map((entry, i) => validateEnvironmentNameRef(entry, `environment[${i}]`, knownProvenanceIds)), (e) => e.name);
  const agentAssets = sortedUnique(boundedArray(raw.agentAssets, "agentAssets", MAX_AGENT_ASSETS).map((entry, i) => validateAgentAssetEntry(entry, `agentAssets[${i}]`, knownProvenanceIds)), agentAssetKey);
  const declaration = {
    version: 1,
    toolchains,
    systemPackages,
    setup,
    verify,
    services,
    environment,
    agentAssets,
    provenance
  };
  assertNoSecretMaterial(declaration);
  return declaration;
}
// packages/environment/src/account-contract.ts
var TOP_LEVEL_FIELDS2 = new Set(["version", "environment", "agentAssets", "provenance"]);
// packages/environment/src/setup-key.ts
var RERUN_WHEN_CHANGED_KEY = "cache_key_files";
var EXCLUDED_SEGMENTS = new Set(["node_modules", ".git"]);
// packages/environment/src/local-image/runner-base.ts
var RUNNER_BASE_REF_PREFIX = "registry.cloudflare.com/080cccc297a4b9cceca559f1095c0d10/catalyst-runner";
var RUNNER_BASE_IMAGE_TAG = "catalyst-runner:1c477b2690b68d0b14386741156ee70b1fd48137";
var RUNNER_BASE_REF = `${RUNNER_BASE_REF_PREFIX}:${RUNNER_BASE_IMAGE_TAG.split(":")[1]}`;
var BAKED_TOOLCHAINS = Object.freeze({
  bun: "1.4.2",
  node: "22.23.2",
  python: "3.12.14",
  go: "1.27.1",
  ruby: "3.4.10",
  java: "temurin-21.0.11+10.0.LTS",
  rust: "1.98.0"
});
var BAKED_TOOLCHAIN_ARGS = Object.freeze({
  node: "NODE_VERSION",
  python: "PYTHON_VERSION",
  go: "GO_VERSION",
  ruby: "RUBY_VERSION",
  java: "JAVA_VERSION",
  rust: "RUST_VERSION"
});
// packages/environment/src/local-image/mise-riding-tools.ts
var MISE_RIDING_TOOLS = Object.freeze({
  node: "node",
  nodejs: "node",
  python: "python"
});
// packages/protocol/src/usage-accounting.ts
var USAGE_RECORD_MAX_BYTES = 64 * 1024;
var USAGE_COUNTER_DESCRIPTORS = {
  cpuUsec: {
    aggregation: "cumulative-counter",
    unit: "microseconds",
    displayUnit: "CPU-seconds",
    displayDivisor: 1e6,
    label: "CPU time",
    kind: "cpu"
  },
  allocatedMemoryByteSeconds: {
    aggregation: "integral",
    unit: "byte-seconds",
    displayUnit: "GiB-seconds",
    displayDivisor: 1024 * 1024 * 1024,
    label: "Allocated memory",
    kind: "memory"
  },
  memoryCurrentBytes: {
    aggregation: "gauge",
    unit: "bytes",
    displayUnit: "bytes",
    displayDivisor: 1,
    label: "Current memory",
    kind: "memory"
  },
  memoryPeakBytes: {
    aggregation: "peak",
    unit: "bytes",
    displayUnit: "bytes",
    displayDivisor: 1,
    label: "Peak memory",
    kind: "memory"
  },
  ioReadBytes: {
    aggregation: "cumulative-counter",
    unit: "bytes",
    displayUnit: "bytes",
    displayDivisor: 1,
    label: "Disk read",
    kind: "disk-io"
  },
  ioWriteBytes: {
    aggregation: "cumulative-counter",
    unit: "bytes",
    displayUnit: "bytes",
    displayDivisor: 1,
    label: "Disk write",
    kind: "disk-io"
  },
  networkRxBytes: {
    aggregation: "cumulative-counter",
    unit: "bytes",
    displayUnit: "bytes",
    displayDivisor: 1,
    label: "Network received",
    kind: "network"
  },
  networkTxBytes: {
    aggregation: "cumulative-counter",
    unit: "bytes",
    displayUnit: "bytes",
    displayDivisor: 1,
    label: "Network sent",
    kind: "network"
  },
  oomEvents: {
    aggregation: "cumulative-counter",
    unit: "count",
    displayUnit: "count",
    displayDivisor: 1,
    label: "OOM events",
    kind: "reliability"
  },
  oomKillEvents: {
    aggregation: "cumulative-counter",
    unit: "count",
    displayUnit: "count",
    displayDivisor: 1,
    label: "OOM kills",
    kind: "reliability"
  },
  oomGroupKillEvents: {
    aggregation: "cumulative-counter",
    unit: "count",
    displayUnit: "count",
    displayDivisor: 1,
    label: "OOM group kills",
    kind: "reliability"
  }
};
var COUNTER_KEYS = Object.keys(USAGE_COUNTER_DESCRIPTORS);
var counterAggregations = Object.fromEntries(Object.entries(USAGE_COUNTER_DESCRIPTORS).map(([key, descriptor]) => [
  key,
  descriptor.aggregation
]));

// packages/protocol/src/project-workspace.ts
var PROJECT_WORKSPACE_MAX_REPOSITORIES = 16;
var INTAKE_MAX_REPOSITORIES = PROJECT_WORKSPACE_MAX_REPOSITORIES - 1;
// packages/protocol/src/provider-retry-window.ts
var RESET_VOCAB = String.raw`\b(?:will\s+reset|resets?|limit\s+resets?|try\s+again)\b[^\n]{0,40}?\bat\b`;
var ANCHORED_ISO = new RegExp(RESET_VOCAB + String.raw`[^\n]{0,10}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)`, "i");
var ANCHORED_EPOCH = new RegExp(RESET_VOCAB + String.raw`[^\n]{0,10}?\|?\s*(\d{10})\b`, "i");
var SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
var CLOCK_RESET_PASSED_GRACE_MS = 60 * 60 * 1000;
var QUARTER_HOUR_MS = 15 * 60 * 1000;
var MAX_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;
var MAX_FOLD_MS = 60 * 60 * 1000;
// packages/protocol/src/worker-agent-id.ts
var ROSTER_LIVE_WITHIN_MS = 10 * 60000;
// packages/protocol/src/context-policy.ts
var DEFAULT_CONTEXT_POLICY = Object.freeze({
  default: Object.freeze({ handoffAt: 250000, nativeCompactAt: 350000 }),
  phases: Object.freeze({
    intake: Object.freeze({ handoffAt: 200000, nativeCompactAt: 350000 }),
    pr: Object.freeze({ handoffAt: 200000, nativeCompactAt: 350000 })
  })
});
var OFF_CONTEXT_POLICY = Object.freeze({
  mode: "off",
  handoffAt: null,
  nativeCompactAt: null
});
var MODES = new Set([
  "off",
  "native",
  "shadow",
  "enforce"
]);
// packages/protocol/src/subscription-account.ts
var MAX_DECLARED_VALIDITY_MS = 180 * 24 * 60 * 60 * 1000;
// packages/protocol/src/providers.ts
var CATALOG = {
  claude: { protocol: "anthropic", harness: "claude-cli" },
  codex: { protocol: "openai", harness: "codex" },
  glm: {
    protocol: "anthropic",
    harness: "claude-cli",
    anthropicBaseUrl: "https://api.z.ai/api/anthropic"
  },
  qwen: {
    protocol: "anthropic",
    harness: "claude-cli",
    anthropicBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic"
  },
  "glm-opencode": {
    protocol: "anthropic",
    harness: "opencode",
    anthropicBaseUrl: "https://api.z.ai/api/anthropic",
    credentialProvider: "glm"
  },
  "qwen-opencode": {
    protocol: "anthropic",
    harness: "opencode",
    anthropicBaseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
    credentialProvider: "qwen",
    openCodeModelLimits: { "qwen3.8-max": { context: 983616, output: 131072 } }
  }
};
var RUNTIME_PROVIDERS = CATALOG;
function isRuntimeProvider(value) {
  return Object.hasOwn(RUNTIME_PROVIDERS, value);
}
// packages/protocol/src/session-messages.ts
var SESSION_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
var SESSION_MESSAGE_INBOX_MAX_BYTES = 1024 * 1024;
var SESSION_MESSAGE_DELIVERED_MAX_BYTES = 256 * 1024;

// packages/protocol/src/prompt-run.ts
var PROMPT_CAPABLE_PROVIDERS = new Set(["claude"]);

// packages/protocol/src/job-execution.ts
var EXECUTION_JOB_MAX_BYTES = 64 * 1024;
var ASK_TRIAGE_EXECUTION_JOB_MAX_BYTES = 160 * 1024;
var EXECUTION_RESULT_MAX_BYTES = 64 * 1024;
var EXECUTION_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
var EXECUTION_MAX_TOTAL_ARTIFACT_BYTES = 256 * 1024 * 1024;
var PREPARATION_MAX_PART_BYTES = 32 * 1024 * 1024;
var EXECUTION_HANDOVER_GATE_PHASES = new Set(["implement", "remediate"]);
var EXECUTION_NO_REPO_SECRETS_PHASES = new Set(["intake", "respond"]);
var utf8Bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
var REPAIR_SCOPE_KEY_BYTES = utf8Bytes({ a: 0, repairScope: 0 }) - utf8Bytes({ a: 0 }) - 1;
var PRIOR_RECHECK_KEY_BYTES = utf8Bytes({ a: 0, priorRecheck: 0 }) - utf8Bytes({ a: 0 }) - 1;
var EXECUTION_EXIT_CODE_MIN = -(2 ** 31);
var EXECUTION_EXIT_CODE_MAX = 2 ** 32 - 1;
var VERDICT_UNREPORTED_REASONS = [
  "no_block",
  "malformed_json",
  "unsupported_version",
  "not_an_object",
  "missing_exit_code"
];
var BUILD_UNREPORTED_REASONS = [...VERDICT_UNREPORTED_REASONS, "missing_attempted"];
var GATE_UNREPORTED_REASONS = [...VERDICT_UNREPORTED_REASONS, "missing_ran"];

// packages/protocol/src/client.ts
var LADDER_MAX_SERIALIZED_BYTES = 8 * 1024;
var OFF_PLAN_MAX_SERIALIZED_BYTES = 16 * 1024;
// packages/protocol/src/environment-check.ts
var ENV_CHECK_REPORT_MAX_BYTES = 8 * 1024;
// packages/protocol/src/container-instance.ts
var CONTAINER_INSTANCE_SPECS = {
  lite: { vcpu: 1 / 16, memoryMiB: 256, diskGB: 2 },
  dev: { vcpu: 1 / 16, memoryMiB: 256, diskGB: 2 },
  basic: { vcpu: 1 / 4, memoryMiB: 1024, diskGB: 4 },
  "standard-1": { vcpu: 1 / 2, memoryMiB: 4096, diskGB: 8 },
  standard: { vcpu: 1 / 2, memoryMiB: 4096, diskGB: 8 },
  "standard-2": { vcpu: 1, memoryMiB: 6144, diskGB: 12 },
  "standard-3": { vcpu: 2, memoryMiB: 8192, diskGB: 16 },
  "standard-4": { vcpu: 4, memoryMiB: 12288, diskGB: 20 },
  "custom-2x6144x12000": { vcpu: 2, memoryMiB: 6144, diskGB: 12 },
  "custom-2x7168x14000": { vcpu: 2, memoryMiB: 7168, diskGB: 14 }
};
var RUNNER_SIZE_CLASSES = ["standard", "large"];
// packages/protocol/src/phase-resources.ts
var GiB = 1024 ** 3;
var PHASE_SIZE_CLASSES = Object.freeze({
  gate: Object.freeze({ cpuMillis: 6000, memoryBytes: 9 * GiB, pidsLimit: 4096 }),
  standard: Object.freeze({ cpuMillis: 2000, memoryBytes: 6 * GiB, pidsLimit: 512 })
});
var GATE_PHASES = Object.freeze(["implement", "validate", "remediate"]);
var PHASE_SIZE_CLASS = Object.freeze({
  intake: "standard",
  research: "standard",
  plan: "standard",
  implement: "gate",
  validate: "gate",
  pr: "standard",
  remediate: "gate",
  respond: "standard",
  prompt: "standard",
  "ask-triage": "standard"
});
// packages/protocol/src/container-pricing.ts
var MAX_DURATION_MS = 7 * 24 * 60 * 60000;
// packages/protocol/src/attempt-git.ts
var ATTEMPT_GIT_TOKEN_MAX_TTL_MS = 60 * 60 * 1000;
// packages/protocol/src/host-enrollment.ts
var JOIN_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1000;
var JOIN_TOKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;
var HOST_CREDENTIAL_ROTATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// packages/protocol/src/phase-prerequisites.ts
var PHASE_PREREQUISITES = [
  {
    id: "harness.claude",
    harness: "claude-cli",
    probe: { kind: "cli", names: ["claude"] },
    severity: { container: "required", workstation: "warn" },
    remedy: "install Claude Code (`claude`) on PATH"
  },
  {
    id: "harness.codex",
    harness: "codex",
    probe: { kind: "cli", names: ["codex"] },
    severity: { container: "required", workstation: "warn" },
    remedy: "install the Codex CLI (`codex`) on PATH"
  },
  {
    id: "harness.opencode",
    harness: "opencode",
    probe: { kind: "cli", names: ["opencode"] },
    severity: { container: "required", workstation: "warn" },
    remedy: "install OpenCode (`opencode`) on PATH"
  },
  {
    id: "toolchain.node",
    probe: { kind: "cli", names: ["node"] },
    severity: { container: "required", workstation: "required" },
    remedy: "install Node.js on PATH"
  },
  {
    id: "toolchain.npm",
    probe: { kind: "cli", names: ["npm"] },
    severity: { container: "required", workstation: "required" },
    remedy: "install npm (it ships with Node.js) on PATH"
  },
  {
    id: "toolchain.bun",
    probe: { kind: "cli", names: ["bun"] },
    severity: { container: "required", workstation: "warn" },
    remedy: "install Bun on PATH"
  },
  {
    id: "toolchain.git",
    probe: { kind: "cli", names: ["git"] },
    severity: { container: "required", workstation: "required" },
    remedy: "install Git on PATH"
  },
  {
    id: "toolchain.mise",
    probe: { kind: "cli", names: ["mise"] },
    severity: { container: "required" },
    remedy: "the runner image must bake mise on PATH"
  },
  {
    id: "browser.chromium",
    probe: { kind: "cli", names: ["chromium"] },
    severity: { container: "required" },
    remedy: "the runner image must bake Debian's `chromium` wrapper on PATH"
  },
  {
    id: "browser.chromium-flags",
    probe: { kind: "file", path: "/etc/chromium.d/zz-catalyst" },
    severity: { container: "required" },
    remedy: "the runner image must write /etc/chromium.d/zz-catalyst (--no-sandbox, --disable-dev-shm-usage); without it Chromium dies in the container"
  },
  {
    id: "browser.chrome",
    probe: {
      kind: "cli",
      names: ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"],
      paths: ["/Applications/Google Chrome.app", "/Applications/Chromium.app"]
    },
    severity: { workstation: "warn" },
    remedy: "install Chrome or Chromium so browser-driven checks can run"
  },
  {
    id: "skills.bundle",
    probe: { kind: "skills", location: "bundle" },
    severity: { container: "required" },
    remedy: "the baked plugin bundle must list every phase skill under skills/"
  },
  {
    id: "skills.home",
    probe: { kind: "skills", location: "home" },
    severity: { container: "warn", workstation: "required" },
    remedy: "install the Catalyst skill packs so $HOME/.agents/skills or $HOME/.claude/skills lists them"
  },
  {
    id: "env.otel-endpoint",
    suppliedBy: "host",
    probe: { kind: "env", anyOf: [["OTEL_EXPORTER_OTLP_ENDPOINT"]] },
    severity: { container: "required", workstation: "warn" },
    remedy: "in a container the endpoint was cleared, not forgotten: the image bakes it and the guest keeps it only when the host also passes the ingest pair, so check the launcher and the host's pair; on a workstation, set OTEL_EXPORTER_OTLP_ENDPOINT to export telemetry"
  },
  {
    id: "env.otel-credentials",
    suppliedBy: "host",
    probe: {
      kind: "env",
      anyOf: [
        ["OTEL_INGEST_CLIENT_ID", "OTEL_INGEST_CLIENT_SECRET", "CATALYST_SUBSTRATE_HOST_NAME"]
      ]
    },
    severity: { container: "required" },
    remedy: "the host must pass the OTel ingest client id and secret and CATALYST_SUBSTRATE_HOST_NAME to the phase container; without them the phase is neither billed nor observed"
  },
  {
    id: "env.claude-code-telemetry",
    harness: "claude-cli",
    probe: {
      kind: "env",
      anyOf: [
        [
          "CLAUDE_CODE_ENABLE_TELEMETRY",
          "OTEL_METRICS_EXPORTER",
          "OTEL_LOGS_EXPORTER",
          "OTEL_TRACES_EXPORTER",
          "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
          "OTEL_EXPORTER_OTLP_PROTOCOL",
          "OTEL_LOG_USER_PROMPTS",
          "OTEL_LOG_TOOL_DETAILS",
          "OTEL_LOG_TOOL_CONTENT"
        ]
      ]
    },
    severity: { container: "required" },
    remedy: "the runner image must set Claude Code's telemetry environment (images/runner/Dockerfile ENV)"
  },
  {
    id: "env.claude-code-telemetry-enabled",
    probe: { kind: "env", anyOf: [["CLAUDE_CODE_ENABLE_TELEMETRY"]] },
    severity: { workstation: "warn" },
    remedy: "set CLAUDE_CODE_ENABLE_TELEMETRY=1 to send Claude Code telemetry (optional on a workstation)"
  },
  {
    id: "host.docker-reachable",
    probe: { kind: "host" },
    severity: { host: "required" },
    remedy: "the Docker engine must be reachable through the mounted socket; nothing runs without it"
  },
  {
    id: "host.docker-socket-gid",
    probe: { kind: "host" },
    severity: { host: "required" },
    remedy: "DOCKER_SOCKET_GID must equal the Docker socket's group, or the non-root services get EACCES"
  },
  {
    id: "host.disk-mode",
    probe: { kind: "host" },
    severity: { host: "required" },
    remedy: "CATALYST_SLOT_DISK_MODE=filesystem needs loop devices, which macOS refuses (losetup EPERM); use CATALYST_SLOT_DISK_MODE=budget"
  },
  {
    id: "host.attempt-label-namespace",
    probe: { kind: "host" },
    severity: { host: "required" },
    remedy: "the attempt-label namespace must be disjoint from any other stack on the box; foreign attempt containers are refused, never touched"
  },
  {
    id: "host.image-platform",
    probe: { kind: "host" },
    severity: { host: "warn" },
    remedy: "the runner image is built for another CPU architecture, so phases run under emulation, slowly; expected until the multi-arch image ships (CTC-3356)"
  }
];
var PREREQUISITE_HARNESS_CLIS = PHASE_PREREQUISITES.flatMap((entry) => entry.harness !== undefined && entry.probe.kind === "cli" ? entry.probe.names : []);
// packages/environment/src/import/agents.ts
var SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

// packages/environment/src/import/devcontainer.ts
var IGNORED_STRUCTURAL_KEYS = new Set([
  "name",
  "workspaceFolder",
  "workspaceMount",
  "customizations",
  "forwardPorts",
  "portsAttributes",
  "runArgs",
  "shutdownAction",
  "$schema",
  "remoteUser",
  "containerUser"
]);

// packages/environment/src/import/workflow.ts
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
// packages/environment/src/propose.ts
var DECISIONS_FIELDS = new Set(["placeAsSetup", "placeAsVerify", "timeoutSecondsByKey"]);
class IdAllocator {
  used;
  counts = new Map;
  constructor(existingIds) {
    this.used = new Set(existingIds);
  }
  next(kind) {
    let n = (this.counts.get(kind) ?? 0) + 1;
    let id = `${kind}-import-${n}`;
    while (this.used.has(id)) {
      n += 1;
      id = `${kind}-import-${n}`;
    }
    this.counts.set(kind, n);
    this.used.add(id);
    return id;
  }
  peek(kind) {
    let n = (this.counts.get(kind) ?? 0) + 1;
    let id = `${kind}-import-${n}`;
    while (this.used.has(id)) {
      n += 1;
      id = `${kind}-import-${n}`;
    }
    return id;
  }
}
// packages/environment/src/redact.ts
var TOKEN_BODY_CHARS = "A-Za-z0-9_+/=-";
var OPAQUE_TOKEN_RE = new RegExp(`(?=[${TOKEN_BODY_CHARS}]*[0-9])(?=[${TOKEN_BODY_CHARS}]*[A-Za-z])[${TOKEN_BODY_CHARS}]{20,}`, "g");
var ABSOLUTE_PATH_RE = new RegExp(`(?<![${TOKEN_BODY_CHARS}])/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+`, "g");
// packages/environment/src/declaration-path.ts
var ENVIRONMENT_DECLARATION_PATH = "catalyst.env.json";
var RULES = [
  {
    rule: "environment declaration under .catalyst/",
    re: /\.catalyst\/environment\.(?:json|toml|ya?ml)\b/
  },
  {
    rule: "environment declaration under catalyst/",
    re: /(?:^|[\s(`"'])catalyst\/environment\.(?:json|toml|ya?ml)\b/
  }
];
var MISNAMED_DECLARATION_RULE_NAMES = RULES.map((r) => r.rule);
// packages/environment/src/minimal-example.ts
var MINIMAL_DECLARATION_EXAMPLE = {
  version: 1,
  toolchains: [{ name: "bun", version: "1.3.14", provenanceIds: ["human-1"] }],
  systemPackages: [],
  setup: [
    {
      id: "install",
      command: ["bun", "install"],
      timeoutSeconds: 900,
      provenanceIds: ["human-1"]
    }
  ],
  verify: [
    {
      id: "check",
      command: ["bun", "run", "check"],
      timeoutSeconds: 3600,
      provenanceIds: ["human-1"]
    }
  ],
  services: [],
  environment: [{ name: "DATABASE_URL", required: true, provenanceIds: ["human-1"] }],
  agentAssets: [],
  provenance: [
    {
      id: "human-1",
      kind: "human",
      path: ENVIRONMENT_DECLARATION_PATH,
      confidence: "high",
      explanation: "Written by hand."
    }
  ]
};
var MINIMAL_DECLARATION_EXAMPLE_JSON = JSON.stringify(MINIMAL_DECLARATION_EXAMPLE, null, 2);
// packages/environment/src/system-package-capture.ts
var MAX_PACKAGE_INVENTORY_BYTES = 256 * 1024;
// packages/environment/src/environment-probe.ts
var BROWSER_PROGRAM = String.raw`import{spawnSync as s}from"node:child_process";import{mkdirSync as m,writeFileSync as w}from"node:fs";import{dirname as d}from"node:path";const p=process.argv[1],r=o=>{m(d(p),{recursive:true});w(p,JSON.stringify({version:1,probe:"browser",...o}))},f=x=>x.error?.code==="ENOENT"?"not_found":x.error?.code==="ETIMEDOUT"?"timeout":"spawn_failed";try{const v=s("chromium",["--version"],{encoding:"utf8",timeout:3e4});if(v.error)r({launched:false,reason:f(v)});else if(v.status!==0)r({launched:false,reason:"version_failed"});else{const h=s("chromium",["--headless=new","--dump-dom","about:blank"],{encoding:"utf8",timeout:6e4});r(h.error?{launched:false,reason:f(h)}:h.status===0&&h.stdout.includes("<html")?{launched:true,browserVersion:v.stdout.trim().slice(0,128)}:{launched:false,reason:"headless_failed"})}}catch{r({launched:false,reason:"probe_error"})}`;
var MCP_PROGRAM = String.raw`import{spawn as S}from"node:child_process";import{mkdirSync as m,writeFileSync as w}from"node:fs";let k;const[,p,z]=process.argv,c=JSON.parse(z),r=o=>{k?.kill("SIGKILL");m(p.replace(/\/[^/]*$/,""),{recursive:!0});w(p,JSON.stringify({version:1,probe:"mcp",...o}));process.exit()},x=e=>r({status:"refused",reason:e}),v=t=>{for(const l of[t,...t.split("\n")]){let j;try{j=JSON.parse(l.replace(/^data:\s*/,""))}catch{continue}if(j?.jsonrpc==="2.0"&&j.id===1){const q=j.result;q?.protocolVersion&&q.capabilities&&q.serverInfo?r({status:"completed"}):x("initialize_error")}}};setTimeout(x,c.timeoutMs,"timeout");if(c.url){try{const h=await fetch(c.url,c.init);h.ok||x("http_status");v(await h.text());x("no_response")}catch{x("connect_failed")}}else{let b="";k=S(c.command,c.args,{env:{...process.env,...c.env},stdio:["pipe","pipe","ignore"]});k.on("error",_=>x("spawn_failed")).on("close",_=>x("exited"));k.stdin.on("error",_=>0);k.stdout.on("data",e=>{b+=e;v(b)});k.stdin.write(c.request+"\n")}`;
var TOOLCHAIN_PROGRAM = String.raw`import{spawnSync as s}from"node:child_process";import{mkdirSync as m,writeFileSync as w}from"node:fs";import{dirname as d}from"node:path";const p=process.argv[1],r=[];for(const e of process.argv[2].split(",")){const[n,f]=e.split("|"),v=s(n,[f||"--version"],{encoding:"utf8",timeout:5e3}),t=((v.stdout||v.stderr||"").split("\n")[0]||"").trim().slice(0,128),o={name:n,runs:v.status===0};if(t)o.version=t;r.push(o)}m(d(p),{recursive:!0});w(p,JSON.stringify({version:1,probe:"toolchain",results:r}))`;
var MCP_INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "catalyst-environment-probe", version: "1" }
  }
});
var ENVIRONMENT_PROBE_PROGRAMS = Object.freeze({
  browser: BROWSER_PROGRAM,
  mcp: MCP_PROGRAM,
  toolchain: TOOLCHAIN_PROGRAM
});
// packages/environment/src/tool-prefix.ts
var BAKED_RUST_HOMES = Object.freeze({
  cargoHome: "/opt/catalyst/toolchain/cargo",
  rustupHome: "/opt/catalyst/toolchain/rustup"
});
// packages/environment/src/env-file.ts
var ENV_IMPORT_MAX_BYTES = 256 * 1024;
var OPEN_KEYWORDS = new Set(["if", "for", "while", "until", "case", "function"]);
var CLOSE_KEYWORDS = new Set(["fi", "done", "esac"]);
var CONTROL_ONLY_KEYWORDS = new Set(["then", "else", "elif", "do", "test"]);
var COMMAND_PREFIX_WORDS = new Set(["then", "else", "elif", "do", "!"]);
var SECRET_EXACT_NAMES = new Set(["TOKEN", "KEY", "SECRET"]);
// packages/settings/src/contract.ts
class SettingsValidationError extends Error {
  path;
  reason;
  constructor(path, reason, message) {
    super(message);
    this.path = path;
    this.reason = reason;
    this.name = "SettingsValidationError";
  }
}
var REVIEW_REQUEST_POLICIES = ["on-open", "every-push", "on-demand"];
var PROJECT_WORKFLOW_SLOTS = [
  "dispatch",
  "intake",
  "research",
  "plan",
  "implement",
  "remediate",
  "verify",
  "review",
  "pr",
  "done",
  "canceled"
];
var PROJECT_ROUTING_STAGES = [
  "intake",
  "research",
  "plan",
  "implement",
  "validate",
  "pr",
  "remediate",
  "merge"
];
var PROJECT_WORKFLOW_MODES = ["adopted-recommended", "mapped-existing", "mixed"];
var PROJECT_GIT_AUTOMATIONS = ["off", "managed"];
var PROJECT_EXECUTION_MODES = [
  "local",
  "connected-host",
  "cluster",
  "cloud-native"
];
var PROJECT_ACTIVATION_POLICIES = ["disabled", "manual", "when-ready"];
var PROJECT_TARGET_KINDS = ["host", "cluster", "cloud-region"];
var PRINTABLE_RE2 = /^[\x21-\x7E ]+$/;
function isSettingsRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closedTable(value, allowedFields, path) {
  if (!isSettingsRecord(value)) {
    throw new SettingsValidationError(path, "invalid_shape", `${path} must be a table`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) {
      throw new SettingsValidationError(`${path}.${key}`, "invalid_shape", `unknown field "${path}.${key}"`);
    }
  }
  return value;
}
function tableArray(value, path, maximum) {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(path, "invalid_shape", `${path} must be an array of tables`);
  }
  if (value.length > maximum) {
    throw new SettingsValidationError(path, "invalid_value", `${path} must contain at most ${maximum} items`);
  }
  return value;
}
function stringAt(record, key, path) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new SettingsValidationError(`${path}.${key}`, "invalid_shape", `${path}.${key} must be a string`);
  }
  return value;
}
function boundedStringValue(value, path, maxLength, re, describe) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !re.test(value)) {
    throw new SettingsValidationError(path, "invalid_value", `${path} must be ${describe}`);
  }
  return value;
}
function integerBetween(value, path, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsValidationError(path, "invalid_value", `${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function booleanAt(record, key, path) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new SettingsValidationError(`${path}.${key}`, "invalid_shape", `${path}.${key} must be a boolean`);
  }
  return value;
}
function stringList(value, path, options) {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(path, "invalid_shape", `${path} must be an array of strings`);
  }
  if (value.length < options.minItems || value.length > options.maxItems) {
    throw new SettingsValidationError(path, "invalid_value", `${path} must contain between ${options.minItems} and ${options.maxItems} items`);
  }
  const seen = new Set;
  return value.map((entry, i) => {
    const item = boundedStringValue(entry, `${path}[${i}]`, options.maxLength, PRINTABLE_RE2, options.describe);
    if (options.unique) {
      if (seen.has(item)) {
        throw new SettingsValidationError(path, "duplicate_entry", `${path} contains duplicate entry ${JSON.stringify(item)}`);
      }
      seen.add(item);
    }
    return item;
  });
}
function stringMapAt(record, key, path) {
  const value = record[key];
  if (value === undefined)
    return;
  if (!isSettingsRecord(value)) {
    throw new SettingsValidationError(`${path}.${key}`, "invalid_shape", `${path}.${key} must be a table of strings`);
  }
  const out = {};
  for (const [mapKey, mapValue] of Object.entries(value)) {
    if (typeof mapValue !== "string") {
      throw new SettingsValidationError(`${path}.${key}.${mapKey}`, "invalid_shape", `${path}.${key}.${mapKey} must be a string`);
    }
    out[mapKey] = mapValue;
  }
  return out;
}
function stringArrayAt(record, key, path, maximum) {
  const value = record[key];
  if (value === undefined)
    return;
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(`${path}.${key}`, "invalid_shape", `${path}.${key} must be an array of strings`);
  }
  if (value.length > maximum) {
    throw new SettingsValidationError(`${path}.${key}`, "invalid_value", `${path}.${key} must contain at most ${maximum} items`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new SettingsValidationError(`${path}.${key}[${i}]`, "invalid_shape", `${path}.${key}[${i}] must be a string`);
    }
    return entry;
  });
}

// packages/settings/src/agents-section.ts
var AGENTS_FIELDS = new Set(["harnesses", "credentials", "context"]);
var CONTEXT_FIELDS = new Set(["instructions", "prompts", "hooks"]);
var CODING_ACCOUNT_FIELDS = new Set(["source", "provider"]);
var VARIABLE_FIELDS = new Set(["source", "variable", "provider"]);
var HARNESS_VOCABULARY = new Set(AGENT_ASSET_HARNESSES);
function harnessToProviderHarness(harness) {
  switch (harness) {
    case "claude":
      return "claude-cli";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
  }
}
var ENROLLABLE_HARNESSES = new Set(Object.values(RUNTIME_PROVIDERS).filter((spec) => spec.credentialProvider === undefined).map((spec) => spec.harness));
var INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
var HOOKS_FILES = new Set([".claude/settings.json"]);
var CONTEXT_PATH_MAX = 512;
var CONTEXT_ENTRIES_MAX = 16;
function isRelativeRepoPath(path) {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path))
    return false;
  const segments = path.split("/");
  return !segments.includes("..") && !segments.includes(".");
}
function validateContextEntry(kind, path, at) {
  if (typeof path !== "string" || path.length === 0) {
    throw new SettingsValidationError(at, "invalid_shape", `${at} must be a string`);
  }
  if (path.length > CONTEXT_PATH_MAX) {
    throw new SettingsValidationError(at, "invalid_value", `${at} must be at most ${CONTEXT_PATH_MAX} characters`);
  }
  if (!isRelativeRepoPath(path)) {
    throw new SettingsValidationError(at, "context_path_not_relative", `${at} must be a repository-relative path without ".." segments`);
  }
  if (kind === "instructions" && !INSTRUCTION_FILES.has(path)) {
    throw new SettingsValidationError(at, "context_path_not_loadable", `${at} must be AGENTS.md or CLAUDE.md — the instruction files the harnesses read natively in v1`);
  }
  if (kind === "hooks" && !HOOKS_FILES.has(path)) {
    throw new SettingsValidationError(at, "context_path_not_loadable", `${at} must be .claude/settings.json — the only hooks location any harness has in v1`);
  }
  return path;
}
function validateContextPaths(value) {
  const raw = closedTable(value, CONTEXT_FIELDS, "agents.context");
  const context = {};
  for (const kind of CONTEXT_FIELDS) {
    const entries = raw[kind];
    if (entries === undefined)
      continue;
    if (!Array.isArray(entries)) {
      throw new SettingsValidationError(`agents.context.${kind}`, "invalid_shape", `agents.context.${kind} must be an array of paths`);
    }
    if (entries.length > CONTEXT_ENTRIES_MAX) {
      throw new SettingsValidationError(`agents.context.${kind}`, "invalid_value", `agents.context.${kind} must contain at most ${CONTEXT_ENTRIES_MAX} entries`);
    }
    const seen = new Set;
    context[kind] = entries.map((entry, i) => {
      const path = validateContextEntry(kind, entry, `agents.context.${kind}[${i}]`);
      if (seen.has(path)) {
        throw new SettingsValidationError(`agents.context.${kind}`, "duplicate_entry", `agents.context.${kind} contains duplicate entry ${JSON.stringify(path)}`);
      }
      seen.add(path);
      return path;
    });
  }
  return context;
}
function validateCodingAccountCredential(raw, harness, at) {
  closedTable(raw, CODING_ACCOUNT_FIELDS, at);
  const provider = raw.provider;
  if (provider === undefined) {
    throw new SettingsValidationError(`${at}.source`, "invalid_shape", `${at}.source = "coding-account" requires a provider`);
  }
  if (typeof provider !== "string" || !isRuntimeProvider(provider)) {
    throw new SettingsValidationError(`${at}.provider`, "unknown_provider", `${at}.provider must be a runtime provider catalog key (${Object.keys(RUNTIME_PROVIDERS).map((key) => JSON.stringify(key)).join(", ")}), not a protocol name`);
  }
  const spec = RUNTIME_PROVIDERS[provider];
  if (spec.credentialProvider !== undefined) {
    throw new SettingsValidationError(`${at}.provider`, "provider_not_enrollable", `${at}.provider ${JSON.stringify(provider)} is a twin view of ${JSON.stringify(spec.credentialProvider)} and is never enrollable; name the enrollable provider instead`);
  }
  const expected = harnessToProviderHarness(harness);
  if (!ENROLLABLE_HARNESSES.has(expected)) {
    throw new SettingsValidationError(`${at}.provider`, "provider_not_enrollable", `no enrollable provider rides the ${expected} harness; ${at} must use source = "variable"`);
  }
  if (spec.harness !== expected) {
    throw new SettingsValidationError(`${at}.provider`, "provider_harness_mismatch", `${at}.provider ${JSON.stringify(provider)} rides the ${spec.harness} harness, not ${expected}`);
  }
  return { source: "coding-account", provider };
}
function validateVariableCredential(raw, harness, at, declaredVariables) {
  closedTable(raw, VARIABLE_FIELDS, at);
  const variable = raw.variable;
  if (typeof variable !== "string" || variable.length === 0) {
    throw new SettingsValidationError(`${at}.variable`, "invalid_shape", `${at}.source = "variable" requires a variable name`);
  }
  const declared = declaredVariables.find((entry) => entry.name === variable);
  if (declared === undefined) {
    throw new SettingsValidationError(`${at}.variable`, "undeclared_variable_reference", `${at}.variable names ${JSON.stringify(variable)}, which is not declared in [[environment.variables]]`);
  }
  if (declared.secret !== true) {
    throw new SettingsValidationError(`${at}.variable`, "credential_variable_not_secret", `${at}.variable names ${JSON.stringify(variable)}, which is declared without secret = true — a credential reference must name a secret variable`);
  }
  const provider = raw.provider;
  if (provider === undefined) {
    return { source: "variable", variable };
  }
  if (typeof provider !== "string" || !isRuntimeProvider(provider)) {
    throw new SettingsValidationError(`${at}.provider`, "unknown_provider", `${at}.provider must be a runtime provider catalog key (${Object.keys(RUNTIME_PROVIDERS).map((key) => JSON.stringify(key)).join(", ")}), not a protocol name`);
  }
  const spec = RUNTIME_PROVIDERS[provider];
  const expected = harnessToProviderHarness(harness);
  if (spec.harness !== expected) {
    throw new SettingsValidationError(`${at}.provider`, "provider_harness_mismatch", `${at}.provider ${JSON.stringify(provider)} rides the ${spec.harness} harness, not ${expected}`);
  }
  return { source: "variable", variable, provider };
}
function agentsSectionFromToml(value, declaredVariables) {
  const raw = closedTable(value, AGENTS_FIELDS, "agents");
  const rawHarnesses = raw.harnesses;
  if (!Array.isArray(rawHarnesses) || rawHarnesses.length === 0) {
    throw new SettingsValidationError("agents.harnesses", "invalid_shape", "agents.harnesses must be a non-empty array of harness names");
  }
  const seenHarnesses = new Set;
  const harnesses = rawHarnesses.map((entry, i) => {
    if (typeof entry !== "string" || !HARNESS_VOCABULARY.has(entry)) {
      throw new SettingsValidationError(`agents.harnesses[${i}]`, "unknown_harness", `agents.harnesses[${i}] must be one of ${AGENT_ASSET_HARNESSES.map((h) => JSON.stringify(h)).join(", ")}`);
    }
    if (seenHarnesses.has(entry)) {
      throw new SettingsValidationError("agents.harnesses", "duplicate_entry", `agents.harnesses contains duplicate entry ${JSON.stringify(entry)}`);
    }
    seenHarnesses.add(entry);
    return entry;
  });
  const section = { harnesses };
  if (raw.credentials !== undefined) {
    const credentialsTable = raw.credentials;
    if (!isSettingsRecord(credentialsTable)) {
      throw new SettingsValidationError("agents.credentials", "invalid_shape", "agents.credentials must be a table keyed by harness name");
    }
    const credentials = {};
    for (const [harness, entry] of Object.entries(credentialsTable)) {
      const at = `agents.credentials.${harness}`;
      if (!HARNESS_VOCABULARY.has(harness)) {
        throw new SettingsValidationError(at, "unknown_harness", `${at} must be one of ${AGENT_ASSET_HARNESSES.map((h) => JSON.stringify(h)).join(", ")}`);
      }
      if (!seenHarnesses.has(harness)) {
        throw new SettingsValidationError(at, "harness_not_allowed", `${at} names a harness outside agents.harnesses`);
      }
      if (!isSettingsRecord(entry)) {
        throw new SettingsValidationError(at, "invalid_shape", `${at} must be a table`);
      }
      if (entry.source === "coding-account") {
        credentials[harness] = validateCodingAccountCredential(entry, harness, at);
      } else if (entry.source === "variable") {
        credentials[harness] = validateVariableCredential(entry, harness, at, declaredVariables);
      } else {
        throw new SettingsValidationError(`${at}.source`, "invalid_value", `${at}.source must be "coding-account" or "variable"`);
      }
    }
    section.credentials = credentials;
  }
  if (raw.context !== undefined) {
    section.context = validateContextPaths(raw.context);
  }
  return section;
}

// packages/settings/src/environment-section.ts
var ENVIRONMENT_SECTION_FIELDS = new Set([
  "toolchains",
  "system_packages",
  "setup",
  "verify",
  "services",
  "variables",
  "mcp_servers",
  "skills",
  "clis",
  "start",
  "container",
  "files"
]);
var TOOLCHAIN_FIELDS2 = new Set(["name", "version"]);
var SYSTEM_PACKAGE_FIELDS2 = new Set(["name", "version"]);
var STEP_FIELDS = new Set(["name", "run", "cwd", "timeout_seconds"]);
var CWD_PARENT_SEGMENT_RE = /(?:^|\/)\.\.(?:\/|$)/;
var SETUP_STEP_FIELDS = new Set([...STEP_FIELDS, RERUN_WHEN_CHANGED_KEY]);
var SERVICE_FIELDS2 = new Set(["name", "image", "readiness"]);
var SERVICE_READINESS_COMMAND_FIELDS2 = new Set(["kind", "run", "timeout_seconds"]);
var SERVICE_READINESS_PORT_FIELDS2 = new Set(["kind", "port"]);
var VARIABLE_FIELDS2 = new Set(["name", "required", "secret"]);
var MCP_FIELDS = new Set([
  "name",
  "transport",
  "url",
  "headers",
  "command",
  "args",
  "env",
  "required_env_names",
  "harnesses"
]);
var MCP_HTTP_FIELDS2 = new Set([
  "name",
  "transport",
  "url",
  "headers",
  "required_env_names",
  "harnesses"
]);
var MCP_STDIO_FIELDS2 = new Set([
  "name",
  "transport",
  "command",
  "args",
  "env",
  "required_env_names",
  "harnesses"
]);
var SKILL_FIELDS2 = new Set(["name", "tier", "reference", "digest", "required_env_names"]);
var CLI_FIELDS2 = new Set(["name", "install"]);
var CLI_IMAGE_FIELDS2 = new Set(["source"]);
var CLI_NPM_FIELDS2 = new Set(["source", "package", "version"]);
var STEP_ID_RE2 = /^[a-z][a-z0-9-]{0,63}$/;
var IMAGE_RE2 = /^[\x21-\x7E]{1,256}$/;
var RERUN_PATH_RE = /^[\x21-\x2E\x30-\x7E][\x21-\x7E]{0,255}$/;
var PARENT_SEGMENT_RE = /(?:^|\/)\.\.(?:\/|$)/;
var MAX_RERUN_ENTRIES2 = 64;
var MAX_RERUN_ENTRY_LENGTH2 = 256;
var DEFAULT_TIMEOUT_SECONDS = 3600;
var MIN_TIMEOUT_SECONDS2 = 1;
var MAX_TIMEOUT_SECONDS2 = 3600;
var MAX_ARGV = 64;
var MAX_ARGV_ITEM = 1024;
var ARG_RE2 = /^[\x20-\x7E]{1,1024}$/;
function contractFailure(err) {
  const body = err.message.replace(/^invalid repo environment declaration: /, "");
  const token = body.split(/\s+/, 1)[0] ?? "";
  const reason = err.reason === "literal_secret" || /secret/.test(body) ? "literal_secret" : /duplicate/.test(body) ? "duplicate_entry" : "invalid_value";
  if (/[.[]/.test(token)) {
    return new SettingsValidationError(token, reason, body);
  }
  const prefixed = `environment.${body}`;
  return new SettingsValidationError(token.length > 0 ? `environment.${token}` : "environment", reason, prefixed);
}
function timeoutAt(value, path) {
  return integerBetween(value, path, MIN_TIMEOUT_SECONDS2, MAX_TIMEOUT_SECONDS2);
}
function contractValidated(run) {
  try {
    return run();
  } catch (err) {
    if (err instanceof EnvironmentContractError)
      throw contractFailure(err);
    throw err;
  }
}
function optionalTableArray(value, path, maximum) {
  if (value === undefined)
    return [];
  return tableArray(value, path, maximum);
}
function assertNoDuplicateIdentities(entries, identityOf, path) {
  const seen = new Set;
  for (const entry of entries) {
    const identity = identityOf(entry);
    if (seen.has(identity)) {
      throw new SettingsValidationError(path, "duplicate_entry", `${path} contains duplicate name ${JSON.stringify(identity)}`);
    }
    seen.add(identity);
  }
}
function validateArgv(value, path) {
  if (!Array.isArray(value)) {
    throw new SettingsValidationError(path, "invalid_shape", `${path} must be an array of strings`);
  }
  if (value.length === 0) {
    throw new SettingsValidationError(path, "invalid_value", `${path} must contain at least one argument`);
  }
  if (value.length > MAX_ARGV) {
    throw new SettingsValidationError(path, "invalid_value", `${path} must contain at most ${MAX_ARGV} items`);
  }
  return value.map((entry, i) => boundedStringValue(entry, `${path}[${i}]`, MAX_ARGV_ITEM, ARG_RE2, "a printable argument of at most 1024 characters"));
}
function inferTransport(raw, path) {
  const hasUrl = raw.url !== undefined;
  const hasCommand = raw.command !== undefined;
  if (hasUrl && hasCommand) {
    throw new SettingsValidationError(`${path}.transport`, "invalid_shape", `${path}.transport is ambiguous: both url and command are present`);
  }
  if (!hasUrl && !hasCommand) {
    throw new SettingsValidationError(`${path}.transport`, "invalid_shape", `${path}.transport cannot be inferred: set either url (http) or command (stdio)`);
  }
  const inferred = hasUrl ? "http" : "stdio";
  if (raw.transport !== undefined && raw.transport !== inferred) {
    throw new SettingsValidationError(`${path}.transport`, "invalid_shape", `${path}.transport is ${JSON.stringify(raw.transport)} but the fields imply ${JSON.stringify(inferred)}`);
  }
  return inferred;
}
function environmentStepsFromToml(value, arrayPath, opts) {
  const allowRerun = opts?.allowRerunWhenChanged === true;
  const fields = allowRerun ? SETUP_STEP_FIELDS : STEP_FIELDS;
  return optionalTableArray(value, arrayPath, 64).map((entry, i) => {
    const path = `${arrayPath}[${i}]`;
    const table = closedTable(entry, fields, path);
    const id = boundedStringValue(stringAt(table, "name", path), `${path}.name`, 64, STEP_ID_RE2, "a lowercase kebab-case identifier of at most 64 characters");
    const command = validateArgv(table.run, `${path}.run`);
    const cwd = table.cwd === undefined ? undefined : boundedStringValue(table.cwd, `${path}.cwd`, 512, /^[\x21-\x7E ]+$/, "a printable path of at most 512 characters");
    if (cwd !== undefined && CWD_PARENT_SEGMENT_RE.test(cwd)) {
      throw new SettingsValidationError(`${path}.cwd`, "invalid_value", `${path}.cwd must stay inside the repository (no ".." segment)`);
    }
    const timeoutSeconds = table.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : timeoutAt(table.timeout_seconds, `${path}.timeout_seconds`);
    const rawRerun = table[RERUN_WHEN_CHANGED_KEY];
    const rerunWhenChanged = rawRerun === undefined ? undefined : stringList(rawRerun, `${path}.${RERUN_WHEN_CHANGED_KEY}`, {
      minItems: 1,
      maxItems: MAX_RERUN_ENTRIES2,
      minLength: 1,
      maxLength: MAX_RERUN_ENTRY_LENGTH2,
      unique: true,
      describe: `a repository-relative path or glob of 1-${MAX_RERUN_ENTRY_LENGTH2} printable characters`
    }).map((glob, j) => {
      const posix = glob.replace(/\\/g, "/");
      if (!RERUN_PATH_RE.test(posix) || PARENT_SEGMENT_RE.test(posix)) {
        throw new SettingsValidationError(`${path}.${RERUN_WHEN_CHANGED_KEY}[${j}]`, "invalid_value", `${path}.${RERUN_WHEN_CHANGED_KEY}[${j}] must be repository-relative (no leading "/" and no ".." segment)`);
      }
      return glob;
    });
    return {
      id,
      command,
      ...cwd !== undefined ? { cwd } : {},
      timeoutSeconds,
      ...rerunWhenChanged !== undefined ? { rerunWhenChanged } : {},
      provenanceIds: []
    };
  });
}
function declarationFromEnvironmentSection(section) {
  const raw = closedTable(section, ENVIRONMENT_SECTION_FIELDS, "environment");
  const toolchains = optionalTableArray(raw.toolchains, "environment.toolchains", 32).map((entry, i) => {
    const path = `environment.toolchains[${i}]`;
    const table = closedTable(entry, TOOLCHAIN_FIELDS2, path);
    return {
      name: boundedStringValue(stringAt(table, "name", path), `${path}.name`, 64, DECLARATION_NAME_RE, "a lowercase identifier of at most 64 characters"),
      version: boundedStringValue(stringAt(table, "version", path), `${path}.version`, 64, DECLARATION_VERSION_RE, "a version string of at most 64 characters"),
      provenanceIds: []
    };
  });
  const systemPackages = optionalTableArray(raw.system_packages, "environment.system_packages", 128).map((entry, i) => {
    const path = `environment.system_packages[${i}]`;
    const table = closedTable(entry, SYSTEM_PACKAGE_FIELDS2, path);
    const name = boundedStringValue(stringAt(table, "name", path), `${path}.name`, 64, DECLARATION_NAME_RE, "a lowercase identifier of at most 64 characters");
    const version = table.version === undefined ? undefined : boundedStringValue(table.version, `${path}.version`, 64, DECLARATION_VERSION_RE, "a version string of at most 64 characters");
    return { name, ...version !== undefined ? { version } : {}, provenanceIds: [] };
  });
  const setup = environmentStepsFromToml(raw.setup, "environment.setup", {
    allowRerunWhenChanged: true
  });
  const verify = environmentStepsFromToml(raw.verify, "environment.verify");
  const services = optionalTableArray(raw.services, "environment.services", 16).map((entry, i) => {
    const path = `environment.services[${i}]`;
    const table = closedTable(entry, SERVICE_FIELDS2, path);
    const name = boundedStringValue(stringAt(table, "name", path), `${path}.name`, 64, DECLARATION_NAME_RE, "a lowercase identifier of at most 64 characters");
    const image = table.image === undefined ? undefined : boundedStringValue(table.image, `${path}.image`, 256, IMAGE_RE2, "a printable image reference of at most 256 characters");
    const readiness = table.readiness;
    if (!isSettingsRecord(readiness)) {
      throw new SettingsValidationError(`${path}.readiness`, "invalid_shape", `${path}.readiness must be a table`);
    }
    if (readiness.kind === "command") {
      closedTable(readiness, SERVICE_READINESS_COMMAND_FIELDS2, `${path}.readiness`);
      const command = validateArgv(readiness.run, `${path}.readiness.run`);
      const timeoutSeconds = readiness.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : timeoutAt(readiness.timeout_seconds, `${path}.readiness.timeout_seconds`);
      return {
        name,
        ...image !== undefined ? { image } : {},
        readiness: { kind: "command", command, timeoutSeconds },
        provenanceIds: []
      };
    }
    if (readiness.kind === "port") {
      closedTable(readiness, SERVICE_READINESS_PORT_FIELDS2, `${path}.readiness`);
      const port = integerBetween(readiness.port, `${path}.readiness.port`, 1, 65535);
      return {
        name,
        ...image !== undefined ? { image } : {},
        readiness: { kind: "port", port },
        provenanceIds: []
      };
    }
    throw new SettingsValidationError(`${path}.readiness.kind`, "invalid_value", `${path}.readiness.kind must be one of "command", "port"`);
  });
  const variables = optionalTableArray(raw.variables, "environment.variables", 128).map((entry, i) => {
    const path = `environment.variables[${i}]`;
    const table = closedTable(entry, VARIABLE_FIELDS2, path);
    if (table.name === undefined) {
      throw new SettingsValidationError(`${path}.name`, "invalid_shape", `${path}.name must be a string`);
    }
    const required = table.required === undefined ? false : booleanAt(table, "required", path);
    const secret = table.secret === undefined ? false : booleanAt(table, "secret", path);
    return contractValidated(() => validateEnvironmentNameRef({
      name: table.name,
      required,
      ...table.secret !== undefined ? { secret } : {},
      provenanceIds: []
    }, path, new Set));
  });
  const mcpServers = optionalTableArray(raw.mcp_servers, "environment.mcp_servers", 64).map((entry, i) => {
    const path = `environment.mcp_servers[${i}]`;
    const table = closedTable(entry, MCP_FIELDS, path);
    const transport = inferTransport(table, path);
    closedTable(table, transport === "http" ? MCP_HTTP_FIELDS2 : MCP_STDIO_FIELDS2, path);
    const id = stringAt(table, "name", path);
    const url = optionalString(table, "url", path);
    const headers = stringMapAt(table, "headers", path);
    const command = optionalString(table, "command", path);
    const args = stringArrayAt(table, "args", path, MAX_ARGV);
    const env = stringMapAt(table, "env", path);
    const requiredEnvNames = stringArrayAt(table, "required_env_names", path, 32) ?? [];
    const harnesses = stringArrayAt(table, "harnesses", path, 3);
    const built = {
      kind: "mcp-server",
      id,
      transport,
      ...url !== undefined ? { url } : {},
      ...headers !== undefined ? { headers } : {},
      ...command !== undefined ? { command } : {},
      ...args !== undefined ? { args } : {},
      ...env !== undefined ? { env } : {},
      requiredEnvNames,
      ...harnesses !== undefined ? { harnesses } : {},
      provenanceIds: []
    };
    return contractValidated(() => validateAgentAssetEntry(built, path, new Set));
  });
  const skills = optionalTableArray(raw.skills, "environment.skills", 64).map((entry, i) => {
    const path = `environment.skills[${i}]`;
    const table = closedTable(entry, SKILL_FIELDS2, path);
    if (table.tier === "platform") {
      throw new SettingsValidationError(`${path}.tier`, "platform_managed", "Catalyst ships platform skills with every repository; remove this entry");
    }
    const built = {
      kind: "skill",
      id: stringAt(table, "name", path),
      tier: table.tier,
      reference: table.reference,
      ...table.digest !== undefined ? { digest: table.digest } : {},
      requiredEnvNames: stringArrayAt(table, "required_env_names", path, 32) ?? [],
      provenanceIds: []
    };
    return contractValidated(() => validateAgentAssetEntry(built, path, new Set));
  });
  const clis = optionalTableArray(raw.clis, "environment.clis", 64).map((entry, i) => {
    const path = `environment.clis[${i}]`;
    const table = closedTable(entry, CLI_FIELDS2, path);
    const install = table.install;
    if (!isSettingsRecord(install)) {
      throw new SettingsValidationError(`${path}.install`, "invalid_shape", `${path}.install must be a table`);
    }
    if (install.source === "image") {
      closedTable(install, CLI_IMAGE_FIELDS2, `${path}.install`);
    } else if (install.source === "npm") {
      closedTable(install, CLI_NPM_FIELDS2, `${path}.install`);
    }
    const built = {
      kind: "cli",
      id: stringAt(table, "name", path),
      install,
      provenanceIds: []
    };
    return contractValidated(() => validateAgentAssetEntry(built, path, new Set));
  });
  assertNoDuplicateIdentities(toolchains, (t) => t.name, "environment.toolchains");
  assertNoDuplicateIdentities(systemPackages, (p) => p.name, "environment.system_packages");
  assertNoDuplicateIdentities(variables, (v) => v.name, "environment.variables");
  assertNoDuplicateIdentities(mcpServers, (a) => a.id, "environment.mcp_servers");
  assertNoDuplicateIdentities(skills, (a) => a.id, "environment.skills");
  assertNoDuplicateIdentities(clis, (a) => a.id, "environment.clis");
  const declaration = {
    version: 1,
    toolchains,
    systemPackages,
    setup,
    verify,
    services,
    environment: variables,
    agentAssets: [...mcpServers, ...skills, ...clis],
    provenance: []
  };
  try {
    return validateRepoEnvironmentDeclaration(declaration);
  } catch (err) {
    if (err instanceof EnvironmentContractError)
      throw contractFailure(err);
    throw err;
  }
}
function optionalString(record, key, path) {
  if (record[key] === undefined)
    return;
  return stringAt(record, key, path);
}

// packages/protocol/src/merge-evidence.ts
var CLEAN_PASS_LINE_RE = new RegExp("^(?:codex review:\\s*)?(?:" + "no major issues(?: found)?" + "|(?:i )?(?:did|do|could|have|ca)\\s?n't (?:find|found|see|seen|spot|spotted) any major issues" + "|(?:i )?(?:found|find|see|saw|spotted) no major issues" + ")$");
var CODEX_SIGN_OFFS = new Set([
  "keep it up",
  "another round soon, please",
  "more of your lovely prs please",
  "keep them coming",
  "chef's kiss",
  "nice work",
  "breezy",
  ":rocket:",
  "you're on a roll",
  "what shall we delve into next?",
  "bravo",
  "hooray",
  ":tada:",
  "can't wait for the next one",
  ":+1:",
  "delightful",
  "already looking forward to the next diff",
  "swish"
]);
var SECURITY_KEYWORD_RE = new RegExp([
  "\\bauth(?:n|z|entication|enticat\\w*|ori[sz]ation|ori[sz]e[sd]?|ori[sz]ing)?\\b",
  "\\bsecrets?\\b",
  "\\btokens?\\b",
  "\\bcredentials?\\b",
  "\\binjection\\b",
  "\\bsql\\b",
  "\\bxss\\b",
  "\\bssrf\\b",
  "\\bdata[ -]exposure\\b",
  "\\btenant[ -]isolation\\b",
  "\\bcross[ -]tenant\\b"
].join("|"), "i");
var MERGE_EVIDENCE_POLICIES = [
  "codex-attestation",
  "codex-attestation-strict",
  "checks-and-threads"
];
var REVIEW_EVIDENCE_LEGS = new Set([
  "codex",
  "thread-ancestry"
]);
var QUEUE_CONDITION_KEYS = new Set(["queue_conditions", "merge_conditions"]);

// packages/settings/src/variable-refs.ts
var VARIABLE_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
var REFERENCE_EXPANDED_MAP_FIELDS = ["headers", "env"];
function walkStrings(value, path, visit) {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => walkStrings(entry, `${path}[${i}]`, visit));
    return;
  }
  if (isSettingsRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      walkStrings(entry, path === "" ? key : `${path}.${key}`, visit);
    }
  }
}
function declaredVariableNames(parsed) {
  const names = new Set;
  if (!isSettingsRecord(parsed))
    return names;
  const environment = parsed.environment;
  if (!isSettingsRecord(environment) || !Array.isArray(environment.variables))
    return names;
  for (const entry of environment.variables) {
    if (isSettingsRecord(entry) && typeof entry.name === "string")
      names.add(entry.name);
  }
  return names;
}
function lintVariableReferences(parsed) {
  const declared = declaredVariableNames(parsed);
  const issues = [];
  const check = (text, path) => {
    VARIABLE_REF_RE.lastIndex = 0;
    for (const match of text.matchAll(VARIABLE_REF_RE)) {
      const name = match[1] ?? match[2];
      if (name !== undefined && !declared.has(name)) {
        issues.push({
          path,
          reason: "undeclared_variable_reference",
          message: `${path} references ${match[0]}, which is not declared in [[environment.variables]]`
        });
      }
    }
  };
  if (!isSettingsRecord(parsed) || !isSettingsRecord(parsed.environment))
    return issues;
  const servers = parsed.environment.mcp_servers;
  if (!Array.isArray(servers))
    return issues;
  servers.forEach((server, i) => {
    if (!isSettingsRecord(server))
      return;
    for (const field of REFERENCE_EXPANDED_MAP_FIELDS) {
      const map = server[field];
      if (!isSettingsRecord(map))
        continue;
      for (const [name, value] of Object.entries(map)) {
        if (typeof value === "string") {
          check(value, `environment.mcp_servers[${i}].${field}.${name}`);
        }
      }
    }
  });
  return issues;
}

// packages/settings/src/sections.ts
var SETTINGS_MERGE_POLICIES = MERGE_EVIDENCE_POLICIES;
var MERGE_FIELDS = new Set([
  "policy",
  "hold_labels",
  "queue",
  "required_checks",
  "hand_merge_paths"
]);
var REVIEW_FIELDS = new Set(["reviewers", "request", "max_requests"]);
var PULL_REQUESTS_FIELDS = new Set([
  "draft_until_validated",
  "branch_pattern",
  "title_format",
  "commit_convention"
]);
var MERGE_QUEUES = ["mergify", "github"];
var COMMIT_CONVENTIONS = ["conventional", "free-form"];
var HAND_MERGE_PATH_RE = /^[\x21-\x2E\x30-\x7E][\x21-\x7E]{0,255}$/;
var PARENT_SEGMENT_RE2 = /(?:^|\/)\.\.(?:\/|$)/;
var RUNNER_FIELDS = new Set(["concurrency", "context"]);
var RUNNER_CONTEXT_FIELDS = new Set(["handoff_at", "native_compact_at", "phases"]);
var RUNNER_CONTEXT_THRESHOLD_FIELDS = new Set(["handoff_at", "native_compact_at"]);
var RUNNER_PHASE_FIELDS = new Set(PROJECT_ROUTING_STAGES);
var DEFAULT_HANDOFF_AT = 250000;
var DEFAULT_NATIVE_COMPACT_AT = 350000;
var THOUGHTS_KEYS = [
  "repo_owner",
  "repo_name",
  "default_branch",
  "repos_subdir",
  "directory"
];
var THOUGHTS_FIELDS = new Set(THOUGHTS_KEYS);
var PRINTABLE_RE3 = /^[\x21-\x7E ]+$/;
var ANY_TEXT_RE = /^[\s\S]+$/u;
var hasControlCharacter = (text) => [...text].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127);
function mergeSectionFromToml(value) {
  const raw = closedTable(value, MERGE_FIELDS, "merge");
  const section = {};
  if (raw.policy !== undefined) {
    if (typeof raw.policy !== "string" || !SETTINGS_MERGE_POLICIES.includes(raw.policy)) {
      throw new SettingsValidationError("merge.policy", "invalid_value", `merge.policy must be one of ${SETTINGS_MERGE_POLICIES.map((p) => JSON.stringify(p)).join(", ")}`);
    }
    section.policy = raw.policy;
  }
  if (raw.hold_labels !== undefined) {
    section.hold_labels = stringList(raw.hold_labels, "merge.hold_labels", {
      minItems: 0,
      maxItems: 16,
      minLength: 1,
      maxLength: 64,
      unique: true,
      describe: "a label of 1-64 printable characters"
    });
  }
  if (raw.queue !== undefined) {
    if (typeof raw.queue !== "string" || !MERGE_QUEUES.includes(raw.queue)) {
      throw new SettingsValidationError("merge.queue", "invalid_value", `merge.queue must be one of ${MERGE_QUEUES.map((q) => JSON.stringify(q)).join(", ")}`);
    }
    section.queue = raw.queue;
  }
  if (raw.required_checks !== undefined) {
    section.required_checks = stringList(raw.required_checks, "merge.required_checks", {
      minItems: 0,
      maxItems: 32,
      minLength: 1,
      maxLength: 128,
      unique: true,
      describe: "a check name of 1-128 printable characters"
    });
  }
  if (raw.hand_merge_paths !== undefined) {
    section.hand_merge_paths = stringList(raw.hand_merge_paths, "merge.hand_merge_paths", {
      minItems: 0,
      maxItems: 64,
      minLength: 1,
      maxLength: 256,
      unique: true,
      describe: "a repository-relative glob of 1-256 printable characters"
    }).map((glob, i) => {
      if (!HAND_MERGE_PATH_RE.test(glob) || PARENT_SEGMENT_RE2.test(glob)) {
        throw new SettingsValidationError(`merge.hand_merge_paths[${i}]`, "invalid_value", `merge.hand_merge_paths[${i}] must be repository-relative (no leading "/" and no ".." segment)`);
      }
      return glob;
    });
  }
  return section;
}
function reviewSectionFromToml(value) {
  const raw = closedTable(value, REVIEW_FIELDS, "review");
  const section = {};
  if (raw.reviewers !== undefined) {
    section.reviewers = stringList(raw.reviewers, "review.reviewers", {
      minItems: 1,
      maxItems: 8,
      minLength: 1,
      maxLength: 64,
      unique: true,
      describe: "a reviewer name of 1-64 printable characters"
    });
  }
  if (raw.request !== undefined) {
    if (typeof raw.request !== "string" || !REVIEW_REQUEST_POLICIES.includes(raw.request)) {
      throw new SettingsValidationError("review.request", "invalid_value", `review.request must be one of ${REVIEW_REQUEST_POLICIES.map((p) => JSON.stringify(p)).join(", ")}`);
    }
    section.request = raw.request;
  }
  if (raw.max_requests !== undefined) {
    section.max_requests = integerBetween(raw.max_requests, "review.max_requests", 0, 20);
  }
  return section;
}
function pullRequestsSectionFromToml(value) {
  const raw = closedTable(value, PULL_REQUESTS_FIELDS, "pull_requests");
  const section = {};
  if (raw.draft_until_validated !== undefined) {
    section.draft_until_validated = booleanAt(raw, "draft_until_validated", "pull_requests");
  }
  const templated = (key, required) => {
    const text = boundedStringValue(raw[key], `pull_requests.${key}`, 128, key === "title_format" ? ANY_TEXT_RE : PRINTABLE_RE3, key === "title_format" ? "text of at most 128 characters without control characters" : "a printable string of at most 128 characters");
    if (hasControlCharacter(text)) {
      throw new SettingsValidationError(`pull_requests.${key}`, "invalid_value", `pull_requests.${key} must be text of at most 128 characters without control characters`);
    }
    const missing = required.filter((token) => !text.includes(token));
    if (missing.length > 0) {
      throw new SettingsValidationError(`pull_requests.${key}`, "invalid_value", `pull_requests.${key} must contain ${missing.join(" and ")}`);
    }
    return text;
  };
  if (raw.branch_pattern !== undefined) {
    section.branch_pattern = templated("branch_pattern", ["{ticket}"]);
  }
  if (raw.title_format !== undefined) {
    section.title_format = templated("title_format", ["{ticket}", "{summary}"]);
  }
  if (raw.commit_convention !== undefined) {
    if (typeof raw.commit_convention !== "string" || !COMMIT_CONVENTIONS.includes(raw.commit_convention)) {
      throw new SettingsValidationError("pull_requests.commit_convention", "invalid_value", `pull_requests.commit_convention must be one of ${COMMIT_CONVENTIONS.map((c) => JSON.stringify(c)).join(", ")}`);
    }
    section.commit_convention = raw.commit_convention;
  }
  return section;
}
function runnerSectionFromToml(value) {
  const raw = closedTable(value, RUNNER_FIELDS, "runner");
  const section = {};
  if (raw.concurrency !== undefined) {
    section.concurrency = integerBetween(raw.concurrency, "runner.concurrency", 1, 100);
  }
  if (raw.context !== undefined) {
    const context = closedTable(raw.context, RUNNER_CONTEXT_FIELDS, "runner.context");
    const thresholds = contextThresholds(context, "runner.context");
    const resolvedHandoff = thresholds.handoff_at ?? DEFAULT_HANDOFF_AT;
    const resolvedNative = thresholds.native_compact_at ?? DEFAULT_NATIVE_COMPACT_AT;
    checkContextOrder(thresholds, "runner.context", resolvedHandoff, resolvedNative);
    const result = { ...thresholds };
    if (context.phases !== undefined) {
      const phases = closedTable(context.phases, RUNNER_PHASE_FIELDS, "runner.context.phases");
      result.phases = {};
      for (const phase of PROJECT_ROUTING_STAGES) {
        if (phases[phase] === undefined)
          continue;
        const path = `runner.context.phases.${phase}`;
        const phaseRaw = closedTable(phases[phase], RUNNER_CONTEXT_THRESHOLD_FIELDS, path);
        const override = contextThresholds(phaseRaw, path);
        checkContextOrder(override, path, override.handoff_at ?? thresholds.handoff_at ?? (phase === "intake" || phase === "pr" ? 200000 : DEFAULT_HANDOFF_AT), override.native_compact_at ?? resolvedNative);
        result.phases[phase] = override;
      }
    }
    section.context = result;
  }
  return section;
}
function contextThresholds(raw, path) {
  const result = {};
  for (const key of ["handoff_at", "native_compact_at"]) {
    if (raw[key] !== undefined) {
      result[key] = integerBetween(raw[key], `${path}.${key}`, 1, Number.MAX_SAFE_INTEGER);
    }
  }
  return result;
}
function checkContextOrder(explicit, path, handoff, native) {
  if (handoff < native)
    return;
  const key = explicit.handoff_at !== undefined ? "handoff_at" : "native_compact_at";
  throw new SettingsValidationError(`${path}.${key}`, "invalid_value", `${path}.handoff_at must be less than ${path}.native_compact_at`);
}
function thoughtsSectionFromToml(value) {
  const raw = closedTable(value, THOUGHTS_FIELDS, "thoughts");
  const section = {};
  for (const key of THOUGHTS_KEYS) {
    const rawValue = raw[key];
    if (rawValue === undefined)
      continue;
    section[key] = boundedStringValue(stringAt(raw, key, "thoughts"), `thoughts.${key}`, 128, PRINTABLE_RE3, "a printable string of at most 128 characters");
  }
  return section;
}
function scanNonEnvironmentSection(value, section) {
  walkStrings(value, section, (text, path) => {
    try {
      scanForSecretMaterial(text, path);
    } catch (err) {
      if (err instanceof EnvironmentContractError) {
        const body = err.message.replace(/^invalid repo environment declaration: /, "");
        throw new SettingsValidationError(path, "literal_secret", body);
      }
      throw err;
    }
  });
}

// packages/settings/src/environment-runtime.ts
var CONTAINER_SIZE_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
var DEFAULT_FILE_MODE = "0600";
var EGRESS_HOST_PATTERN = "^(\\*\\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$";
var FILE_MODE_PATTERN = "^0[0-7]{3}$";
var RUNTIME_FILE_PATH_PATTERN = "^[\\x21-\\x2E\\x30-\\x7E][\\x21-\\x7E]{0,255}$";
var CONTAINER_FIELDS = new Set(["size", "egress", "git"]);
var GIT_FIELDS = new Set(["submodules", "lfs"]);
var FILE_FIELDS = new Set(["path", "from", "mode"]);
var ENV_NAME_RE4 = /^[A-Za-z_][A-Za-z0-9_]*$/;
var PARENT_SEGMENT_RE3 = /(?:^|\/)\.\.(?:\/|$)/;
function containerFromToml(value) {
  const raw = closedTable(value, CONTAINER_FIELDS, "environment.container");
  const out = {};
  if (raw.size !== undefined) {
    const size = boundedStringValue(raw.size, "environment.container.size", 32, new RegExp(CONTAINER_SIZE_PATTERN), 'a size class name such as "standard"');
    if (!RUNNER_SIZE_CLASSES.includes(size)) {
      throw new SettingsValidationError("environment.container.size", "unknown_size_class", `environment.container.size ${JSON.stringify(size)} is not one of the platform's size classes: ${RUNNER_SIZE_CLASSES.join(", ")}`);
    }
    out.size = size;
  }
  if (raw.egress !== undefined) {
    out.egress = stringList(raw.egress, "environment.container.egress", {
      minItems: 0,
      maxItems: 128,
      minLength: 1,
      maxLength: 253,
      unique: true,
      describe: "a hostname"
    }).map((host, i) => boundedStringValue(host, `environment.container.egress[${i}]`, 253, new RegExp(EGRESS_HOST_PATTERN), 'a lowercase hostname such as "registry.npmjs.org" or "*.stripe.com"'));
  }
  if (raw.git !== undefined) {
    const git = closedTable(raw.git, GIT_FIELDS, "environment.container.git");
    out.git = {};
    if (git.submodules !== undefined) {
      out.git.submodules = booleanAt(git, "submodules", "environment.container.git");
    }
    if (git.lfs !== undefined)
      out.git.lfs = booleanAt(git, "lfs", "environment.container.git");
  }
  return out;
}
function declaredSecretNames(section) {
  const declared = new Set;
  const secret = new Set;
  if (Array.isArray(section.variables)) {
    for (const entry of section.variables) {
      if (!isSettingsRecord(entry) || typeof entry.name !== "string")
        continue;
      declared.add(entry.name);
      if (entry.secret === true)
        secret.add(entry.name);
    }
  }
  return { declared, secret };
}
function filesFromToml(value, section) {
  const { declared, secret } = declaredSecretNames(section);
  const seenPaths = new Set;
  return tableArray(value, "environment.files", 32).map((entry, i) => {
    const path = `environment.files[${i}]`;
    const table = closedTable(entry, FILE_FIELDS, path);
    if (table.path === undefined || table.from === undefined) {
      throw new SettingsValidationError(table.path === undefined ? `${path}.path` : `${path}.from`, "missing_required", `${path} needs both path and from`);
    }
    const filePath = boundedStringValue(table.path, `${path}.path`, 256, new RegExp(RUNTIME_FILE_PATH_PATTERN), "a repository-relative path");
    if (PARENT_SEGMENT_RE3.test(filePath)) {
      throw new SettingsValidationError(`${path}.path`, "invalid_value", `${path}.path must stay inside the repository (no ".." segment)`);
    }
    if (seenPaths.has(filePath)) {
      throw new SettingsValidationError(`${path}.path`, "duplicate_entry", `environment.files writes ${JSON.stringify(filePath)} more than once`);
    }
    seenPaths.add(filePath);
    const from = boundedStringValue(table.from, `${path}.from`, 128, ENV_NAME_RE4, "a variable name");
    if (!declared.has(from)) {
      throw new SettingsValidationError(`${path}.from`, "undeclared_variable_reference", `${path}.from names ${from}, which is not declared in [[environment.variables]]`);
    }
    if (!secret.has(from)) {
      throw new SettingsValidationError(`${path}.from`, "invalid_value", `${path}.from names ${from}, which must be declared with secret = true to be written to a file`);
    }
    const file = {
      path: filePath,
      from,
      mode: table.mode === undefined ? DEFAULT_FILE_MODE : boundedStringValue(table.mode, `${path}.mode`, 4, new RegExp(FILE_MODE_PATTERN), 'an octal permission string such as "0600"')
    };
    return file;
  });
}
function environmentRuntimeFromToml(section) {
  if (!isSettingsRecord(section))
    return {};
  const runtime = {};
  if (section.start !== undefined) {
    const start = environmentStepsFromToml(section.start, "environment.start");
    const ids = new Set;
    for (const [i, step] of start.entries()) {
      if (ids.has(step.id)) {
        throw new SettingsValidationError(`environment.start[${i}].name`, "duplicate_entry", `environment.start has two steps named ${JSON.stringify(step.id)}`);
      }
      ids.add(step.id);
    }
    runtime.start = start;
  }
  if (section.container !== undefined)
    runtime.container = containerFromToml(section.container);
  if (section.files !== undefined)
    runtime.files = filesFromToml(section.files, section);
  for (const key of ["start", "container", "files"]) {
    if (section[key] !== undefined)
      scanNonEnvironmentSection(section[key], `environment.${key}`);
  }
  return runtime;
}

// packages/settings/src/project-section.ts
var LINEAR_TEAM_KEY_PATTERN = "^[A-Z][A-Z0-9]{0,15}$";
var LINEAR_WORKSPACE_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
var GITHUB_REPOSITORY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$";
var ROUTING_PROVIDER_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
var ROUTING_MODEL_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$";
var ROUTING_EFFORT_PATTERN = "^[a-z]{1,16}$";
var CAPABILITY_PATTERN = "^[a-z][a-z0-9._-]{0,63}$";
var EXECUTION_TARGET_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
var PRINTABLE_RE4 = /^[\x21-\x7E ]+$/;
var LABEL_OPTIONS = {
  minItems: 0,
  maxItems: 32,
  minLength: 1,
  maxLength: 64,
  unique: true,
  describe: "a label name of 1-64 printable characters"
};
var PROJECT_FIELDS = new Set([
  "linear_team",
  "linear_workspace",
  "linear",
  "routing",
  "ladder",
  "thoughts",
  "context",
  "intake",
  "repositories",
  "runner",
  "execution"
]);
var LINEAR_FIELDS = new Set(["states", "mode", "git_automation", "labels"]);
var LINEAR_LABEL_FIELDS = new Set(["ask", "hold", "release"]);
var ROUTING_ENTRY_FIELDS = new Set(["provider", "model", "effort"]);
var LADDER_FIELDS = new Set(["intake", "remediate_round_cap", "park_after_failures"]);
var THOUGHTS_FIELDS2 = new Set(["repository", "directory", "profile", "default_branch"]);
var CONTEXT_FIELDS2 = new Set(["index", "wiki_notes"]);
var INTAKE_FIELDS = new Set(["include_labels", "exclude_labels"]);
var REPOSITORIES_FIELDS = new Set(["default", "rules", "list"]);
var RULE_FIELDS = new Set(["label", "linear_project", "repository"]);
var RUNNER_FIELDS2 = new Set(["concurrency"]);
var EXECUTION_FIELDS = new Set(["mode", "activation", "targets", "requires"]);
var TARGET_FIELDS = new Set(["kind", "id"]);
function pattern(value, path, source, maxLength, describe) {
  return boundedStringValue(value, path, maxLength, new RegExp(source), describe);
}
function oneOf(value, path, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new SettingsValidationError(path, "invalid_value", `${path} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
  }
  return value;
}
function printable(value, path, maxLength) {
  return boundedStringValue(value, path, maxLength, PRINTABLE_RE4, `a printable string of at most ${maxLength} characters`);
}
function linearSection(value) {
  const raw = closedTable(value, LINEAR_FIELDS, "project.linear");
  const out = {};
  if (raw.states !== undefined) {
    const states = closedTable(raw.states, new Set(PROJECT_WORKFLOW_SLOTS), "project.linear.states");
    out.states = {};
    for (const [slot, name] of Object.entries(states)) {
      out.states[slot] = printable(name, `project.linear.states.${slot}`, 128);
    }
  }
  if (raw.mode !== undefined)
    out.mode = oneOf(raw.mode, "project.linear.mode", PROJECT_WORKFLOW_MODES);
  if (raw.git_automation !== undefined) {
    out.git_automation = oneOf(raw.git_automation, "project.linear.git_automation", PROJECT_GIT_AUTOMATIONS);
  }
  if (raw.labels !== undefined) {
    const labels = closedTable(raw.labels, LINEAR_LABEL_FIELDS, "project.linear.labels");
    out.labels = {};
    for (const key of ["ask", "hold", "release"]) {
      if (labels[key] !== undefined) {
        out.labels[key] = printable(labels[key], `project.linear.labels.${key}`, 64);
      }
    }
  }
  return out;
}
function routingSection(value) {
  const raw = closedTable(value, new Set(PROJECT_ROUTING_STAGES), "project.routing");
  const out = {};
  for (const [stage, entry] of Object.entries(raw)) {
    const path = `project.routing.${stage}`;
    const table = closedTable(entry, ROUTING_ENTRY_FIELDS, path);
    const routed = {
      provider: pattern(stringAt(table, "provider", path), `${path}.provider`, ROUTING_PROVIDER_PATTERN, 32, 'a provider key such as "claude", "codex" or "glm"')
    };
    if (table.model !== undefined) {
      routed.model = pattern(table.model, `${path}.model`, ROUTING_MODEL_PATTERN, 128, "a model id");
    }
    if (table.effort !== undefined) {
      routed.effort = pattern(table.effort, `${path}.effort`, ROUTING_EFFORT_PATTERN, 16, 'an effort level such as "low", "high" or "max"');
    }
    out[stage] = routed;
  }
  return out;
}
function ladderSection(value) {
  const raw = closedTable(value, LADDER_FIELDS, "project.ladder");
  const out = {};
  if (raw.intake !== undefined)
    out.intake = booleanAt(raw, "intake", "project.ladder");
  if (raw.remediate_round_cap !== undefined) {
    out.remediate_round_cap = integerBetween(raw.remediate_round_cap, "project.ladder.remediate_round_cap", 1, 10);
  }
  if (raw.park_after_failures !== undefined) {
    out.park_after_failures = integerBetween(raw.park_after_failures, "project.ladder.park_after_failures", 1, 10);
  }
  return out;
}
function thoughtsSection(value) {
  const raw = closedTable(value, THOUGHTS_FIELDS2, "project.thoughts");
  const out = {};
  if (raw.repository !== undefined) {
    out.repository = pattern(raw.repository, "project.thoughts.repository", GITHUB_REPOSITORY_PATTERN, 140, 'a GitHub repository written "owner/name"');
  }
  for (const key of ["directory", "profile", "default_branch"]) {
    if (raw[key] !== undefined)
      out[key] = printable(raw[key], `project.thoughts.${key}`, 128);
  }
  return out;
}
function contextSection(value) {
  const raw = closedTable(value, CONTEXT_FIELDS2, "project.context");
  const out = {};
  if (raw.index !== undefined)
    out.index = booleanAt(raw, "index", "project.context");
  if (raw.wiki_notes !== undefined) {
    if (!Array.isArray(raw.wiki_notes) || raw.wiki_notes.length > 32) {
      throw new SettingsValidationError("project.context.wiki_notes", "invalid_value", "project.context.wiki_notes must be an array of at most 32 strings");
    }
    out.wiki_notes = raw.wiki_notes.map((note, i) => {
      if (typeof note !== "string" || note.length === 0 || note.length > 4000) {
        throw new SettingsValidationError(`project.context.wiki_notes[${i}]`, "invalid_value", `project.context.wiki_notes[${i}] must be a non-empty string of at most 4000 characters`);
      }
      return note;
    });
  }
  return out;
}
function intakeSection(value) {
  const raw = closedTable(value, INTAKE_FIELDS, "project.intake");
  const out = {};
  if (raw.include_labels !== undefined) {
    out.include_labels = stringList(raw.include_labels, "project.intake.include_labels", LABEL_OPTIONS);
  }
  if (raw.exclude_labels !== undefined) {
    out.exclude_labels = stringList(raw.exclude_labels, "project.intake.exclude_labels", LABEL_OPTIONS);
  }
  const overlap = (out.include_labels ?? []).filter((l) => (out.exclude_labels ?? []).includes(l));
  if (overlap.length > 0) {
    throw new SettingsValidationError("project.intake.exclude_labels", "invalid_value", `project.intake: ${JSON.stringify(overlap[0])} is both included and excluded`);
  }
  return out;
}
function repositoriesSection(value) {
  const raw = closedTable(value, REPOSITORIES_FIELDS, "project.repositories");
  const out = {};
  const repo = (v, path) => pattern(v, path, GITHUB_REPOSITORY_PATTERN, 140, 'a GitHub repository written "owner/name"');
  if (raw.default !== undefined)
    out.default = repo(raw.default, "project.repositories.default");
  if (raw.rules !== undefined) {
    out.rules = tableArray(raw.rules, "project.repositories.rules", 64).map((entry, i) => {
      const path = `project.repositories.rules[${i}]`;
      const table = closedTable(entry, RULE_FIELDS, path);
      const hasLabel = table.label !== undefined;
      const hasProject = table.linear_project !== undefined;
      if (hasLabel === hasProject) {
        throw new SettingsValidationError(path, "invalid_shape", `${path} must match on exactly one of label or linear_project`);
      }
      const rule = {
        repository: repo(stringAt(table, "repository", path), `${path}.repository`)
      };
      if (hasLabel)
        rule.label = printable(table.label, `${path}.label`, 64);
      if (hasProject)
        rule.linear_project = printable(table.linear_project, `${path}.linear_project`, 128);
      return rule;
    });
  }
  if (raw.list !== undefined) {
    if (!Array.isArray(raw.list) || raw.list.length > 64) {
      throw new SettingsValidationError("project.repositories.list", "invalid_value", "project.repositories.list must be an array of at most 64 GitHub repositories");
    }
    const seen = new Set;
    out.list = raw.list.map((entry, i) => {
      const path = `project.repositories.list[${i}]`;
      const value2 = repo(entry, path);
      const key = value2.toLowerCase();
      if (seen.has(key)) {
        throw new SettingsValidationError(path, "duplicate_entry", `${path} duplicates an earlier entry (case-insensitive): ${JSON.stringify(value2)}`);
      }
      seen.add(key);
      return value2;
    });
  }
  return out;
}
function executionSection(value) {
  const raw = closedTable(value, EXECUTION_FIELDS, "project.execution");
  const out = {};
  if (raw.mode !== undefined)
    out.mode = oneOf(raw.mode, "project.execution.mode", PROJECT_EXECUTION_MODES);
  if (raw.activation !== undefined) {
    out.activation = oneOf(raw.activation, "project.execution.activation", PROJECT_ACTIVATION_POLICIES);
  }
  if (raw.targets !== undefined) {
    out.targets = tableArray(raw.targets, "project.execution.targets", 16).map((entry, i) => {
      const path = `project.execution.targets[${i}]`;
      const table = closedTable(entry, TARGET_FIELDS, path);
      return {
        kind: oneOf(table.kind, `${path}.kind`, PROJECT_TARGET_KINDS),
        id: pattern(stringAt(table, "id", path), `${path}.id`, EXECUTION_TARGET_ID_PATTERN, 128, "a target id of letters, digits and . _ : - (at most 128 characters)")
      };
    });
  }
  if (raw.requires !== undefined) {
    out.requires = stringList(raw.requires, "project.execution.requires", {
      minItems: 0,
      maxItems: 32,
      minLength: 1,
      maxLength: 64,
      unique: true,
      describe: "a capability name of 1-64 printable characters"
    }).map((cap, i) => pattern(cap, `project.execution.requires[${i}]`, CAPABILITY_PATTERN, 64, "a lowercase capability name"));
  }
  return out;
}
function projectSectionFromToml(value) {
  const raw = closedTable(value, PROJECT_FIELDS, "project");
  if (raw.linear_team === undefined) {
    throw new SettingsValidationError("project.linear_team", "missing_required", `project.linear_team is required: name the Linear team this repository's work belongs to, e.g. linear_team = "CTC"`);
  }
  const section = {
    linear_team: pattern(raw.linear_team, "project.linear_team", LINEAR_TEAM_KEY_PATTERN, 16, 'a Linear team key: uppercase letters and digits, e.g. "CTC"')
  };
  if (raw.linear_workspace !== undefined) {
    section.linear_workspace = pattern(raw.linear_workspace, "project.linear_workspace", LINEAR_WORKSPACE_PATTERN, 64, 'a Linear workspace URL key, e.g. "coalesce-labs"');
  }
  if (raw.linear !== undefined)
    section.linear = linearSection(raw.linear);
  if (raw.routing !== undefined)
    section.routing = routingSection(raw.routing);
  if (raw.ladder !== undefined)
    section.ladder = ladderSection(raw.ladder);
  if (raw.thoughts !== undefined)
    section.thoughts = thoughtsSection(raw.thoughts);
  if (raw.context !== undefined)
    section.context = contextSection(raw.context);
  if (raw.intake !== undefined)
    section.intake = intakeSection(raw.intake);
  if (raw.repositories !== undefined)
    section.repositories = repositoriesSection(raw.repositories);
  if (raw.runner !== undefined) {
    const runner = closedTable(raw.runner, RUNNER_FIELDS2, "project.runner");
    section.runner = runner.concurrency === undefined ? {} : { concurrency: integerBetween(runner.concurrency, "project.runner.concurrency", 1, 100) };
  }
  if (raw.execution !== undefined)
    section.execution = executionSection(raw.execution);
  return section;
}

// packages/settings/src/toml.ts
import { parse, stringify, TomlError } from "smol-toml";
function parseSettingsToml(text) {
  try {
    return { ok: true, value: parse(text) };
  } catch (err) {
    if (err instanceof TomlError) {
      const message = err.message.split(`
`, 1)[0] ?? "malformed TOML document";
      return {
        ok: false,
        issue: {
          path: "",
          reason: "toml_parse_error",
          message,
          ...typeof err.line === "number" ? { line: err.line } : {}
        }
      };
    }
    throw err;
  }
}

// packages/settings/src/validate.ts
var TOP_LEVEL_FIELDS3 = new Set([
  "project",
  "merge",
  "review",
  "runner",
  "thoughts",
  "pull_requests",
  "environment",
  "agents"
]);
function issueFrom(err) {
  if (err instanceof SettingsValidationError) {
    return { path: err.path, reason: err.reason, message: err.message };
  }
  throw err;
}
function declaredVariables(parsed) {
  if (!isSettingsRecord(parsed))
    return [];
  const environment = parsed.environment;
  if (!isSettingsRecord(environment) || !Array.isArray(environment.variables))
    return [];
  const out = [];
  for (const entry of environment.variables) {
    if (isSettingsRecord(entry) && typeof entry.name === "string") {
      out.push(entry.secret === true ? { name: entry.name, secret: true } : { name: entry.name });
    }
  }
  return out;
}
function validateSettingsValue(value) {
  if (!isSettingsRecord(value)) {
    return {
      ok: false,
      issues: [
        {
          path: "(root)",
          reason: "invalid_shape",
          message: "the settings file root must be a TOML table"
        }
      ]
    };
  }
  const issues = [];
  const settings = {};
  let environment;
  let runtime;
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS3.has(key)) {
      issues.push({
        path: key,
        reason: "invalid_shape",
        message: `unknown field "${key}"`
      });
    }
  }
  if (value.project === undefined) {
    issues.push({
      path: "project",
      reason: "missing_required",
      message: `[project] is required: name the Linear team this repository's work belongs to, e.g. [project] linear_team = "CTC"`
    });
  } else {
    try {
      settings.project = projectSectionFromToml(value.project);
      scanNonEnvironmentSection(value.project, "project");
    } catch (err) {
      issues.push(issueFrom(err));
    }
  }
  if (value.environment !== undefined) {
    try {
      environment = declarationFromEnvironmentSection(value.environment);
      settings.environment = value.environment;
    } catch (err) {
      issues.push(issueFrom(err));
    }
    try {
      const projection = environmentRuntimeFromToml(value.environment);
      if (projection.start !== undefined || projection.container !== undefined || projection.files !== undefined) {
        runtime = projection;
      }
    } catch (err) {
      issues.push(issueFrom(err));
    }
  }
  const sectionValidators = [
    ["merge", mergeSectionFromToml],
    ["review", reviewSectionFromToml],
    ["runner", runnerSectionFromToml],
    ["thoughts", thoughtsSectionFromToml],
    ["pull_requests", pullRequestsSectionFromToml]
  ];
  for (const [key, validateSection] of sectionValidators) {
    if (value[key] === undefined)
      continue;
    try {
      settings[key] = validateSection(value[key]);
      scanNonEnvironmentSection(value[key], key);
    } catch (err) {
      issues.push(issueFrom(err));
    }
  }
  if (value.agents !== undefined) {
    try {
      settings.agents = agentsSectionFromToml(value.agents, declaredVariables(value));
    } catch (err) {
      issues.push(issueFrom(err));
    }
    try {
      scanNonEnvironmentSection(value.agents, "agents");
    } catch (err) {
      issues.push(issueFrom(err));
    }
  }
  issues.push(...lintVariableReferences(value));
  const ok = issues.length === 0;
  return ok ? {
    ok: true,
    issues: [],
    settings,
    ...environment !== undefined ? { environment } : {},
    ...runtime !== undefined ? { runtime } : {}
  } : { ok: false, issues };
}
function validateCatalystSettings(text) {
  const parsed = parseSettingsToml(text);
  if (!parsed.ok)
    return { ok: false, issues: [parsed.issue] };
  return validateSettingsValue(parsed.value);
}

// entry.ts
function validateFullSettings(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1048576)
      return { ok: false, errors: ["Settings file could not be fully validated"] };
    const result = validateCatalystSettings(text);
    if (!result.ok || !result.settings?.project)
      return { ok: false, errors: ["Settings file could not be fully validated"] };
    const entries = result.environment?.environment ?? [];
    return {
      ok: true,
      errors: [],
      linearTeam: result.settings.project.linear_team,
      variableNames: entries.filter((entry) => entry.secret !== true).map((entry) => entry.name).sort(),
      secretNames: entries.filter((entry) => entry.secret === true).map((entry) => entry.name).sort()
    };
  } catch {
    return { ok: false, errors: ["Settings file could not be fully validated"] };
  }
}
export {
  validateFullSettings
};
