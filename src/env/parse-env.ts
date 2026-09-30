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
