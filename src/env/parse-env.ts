/** Select dotenv assignment lines by name while keeping their original bytes for the cloud's parser.
 *  Unselected values never cross the network boundary. This mirrors the cloud parser's line grammar. */
export function filterEnvFileNames(text: string, selected: ReadonlySet<string>): { text: string; found: string[] } {
  const lines: string[] = [];
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const equals = assignment.indexOf("=");
    if (equals < 0) continue;
    const name = assignment.slice(0, equals).trim();
    if (!selected.has(name)) continue;
    lines.push(line);
    found.add(name);
  }
  return { text: lines.length === 0 ? "" : `${lines.join("\n")}\n`, found: [...found].sort((a, b) => a.localeCompare(b, "en")) };
}

/** Parse dotenv assignments using the mirror import grammar, after the caller has locally selected
 * names. Values stay in this process and are posted one at a time to the documented write route. */
export function parseEnvAssignments(text: string, selected?: ReadonlySet<string>): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];
  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const equals = assignment.indexOf("=");
    if (equals < 0) continue;
    const name = assignment.slice(0, equals).trim();
    if (name === "" || (selected !== undefined && !selected.has(name))) continue;
    const rawValue = assignment.slice(equals + 1);
    let value = rawValue.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    } else {
      const comment = rawValue.search(/\s#/);
      if (comment >= 0) value = rawValue.slice(0, comment).trim();
    }
    entries.push({ name, value });
  }
  return entries;
}
