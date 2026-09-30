const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME_RE =
  /(?:^|_)(?:API_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;

export type LegacyEnvironmentConversion =
  | {
      state: "valid";
      variableNames: string[];
      secretNames: string[];
      toml: string;
    }
  | { state: "invalid"; errors: string[] };

/** Convert legacy catalyst.env.json names only. Values and provenance are never copied. */
export function convertLegacyEnvironmentJson(
  text: string,
): LegacyEnvironmentConversion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "invalid", errors: ["legacy declaration is not valid JSON"] };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.environment)) {
    return {
      state: "invalid",
      errors: ["legacy declaration must contain an environment array"],
    };
  }

  const errors: string[] = [];
  const names = new Set<string>();
  const secretNames: string[] = [];
  for (const [index, entry] of parsed.environment.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !ENV_NAME_RE.test(entry.name)
    ) {
      errors.push(`environment[${index}].name is not a valid environment variable name`);
      continue;
    }
    names.add(entry.name);
    const isSecret = entry.secret === true || SECRET_NAME_RE.test(entry.name);
    if (isSecret && !secretNames.includes(entry.name)) {
      secretNames.push(entry.name);
    }
  }
  const variableNames = [...names].sort();
  if (variableNames.length > 128) errors.push("environment has more than 128 names");
  if (errors.length) return { state: "invalid", errors };

  const toml =
    variableNames.length === 0
      ? "[environment]\n"
      : variableNames
          .map((name) =>
            [
              "[[environment.variables]]",
              `name = ${JSON.stringify(name)}`,
              ...(secretNames.includes(name) ? ["secret = true"] : []),
              "required = false",
              "",
            ].join("\n"),
          )
          .join("\n");
  return { state: "valid", variableNames, secretNames, toml };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
