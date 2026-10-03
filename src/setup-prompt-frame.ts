import { Writable } from "node:stream";
import stringWidth from "fast-string-width";
/** Follow only cursor commands used by Clack. An unknown position keeps the submitted form. */
export function promptCursor(columns: number) {
  let row = 0,
    col = 0,
    known = true;
  return {
    feed(text: string) {
      const tokens =
        text.match(
          /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[^\x1b]+|\x1b/g,
        ) ?? [];
      for (const token of tokens) {
        if (token.startsWith("\x1b[")) {
          const command = token.at(-1);
          const amount = Number.parseInt(token.slice(2), 10) || 1;
          switch (command) {
            case "A":
              row -= amount;
              break;
            case "B":
              row += amount;
              break;
            case "C":
              col = Math.min(columns - 1, col + amount);
              break;
            case "D":
              col = Math.max(0, col - amount);
              break;
            case "G":
              col = amount - 1;
              break;
            case "J":
            case "K":
            case "m":
            case "h":
            case "l":
              break;
            default:
              known = false;
          }
          if (row < 0) known = false;
        } else if (token.startsWith("\x1b]")) continue;
        else if (token === "\x1b") known = false;
        else
          for (const part of token.split(/([\r\n])/)) {
            if (part === "\r") col = 0;
            else if (part === "\n") {
              row++;
              col = 0;
            } else if (part) {
              const cells = stringWidth(part);
              if (cells) {
                row += Math.floor((col + cells - 1) / columns);
                col = ((col + cells - 1) % columns) + 1;
              }
            }
          }
      }
    },
    rows() {
      return known ? row : null;
    },
  };
}
/** Keep Clack's writes on the real output while measuring the submitted form's cursor height. */
export async function trackedPrompt<T>(
  output: Writable,
  run: (output: Writable) => Promise<T>,
): Promise<{ answer: T; rows: number | null }> {
  const reported = Reflect.get(output, "columns");
  const columns = typeof reported === "number" && reported > 0 ? reported : 80;
  const cursor = promptCursor(columns);
  let resized = false;
  const proxy = new Writable({
    write(chunk, encoding, callback) {
      cursor.feed(String(chunk));
      output.write(chunk, encoding, callback);
    },
  });
  for (const key of ["columns", "rows", "isTTY"])
    Object.defineProperty(proxy, key, { get: () => Reflect.get(output, key) });
  const resize = () => {
    resized = true;
    proxy.emit("resize");
  };
  output.on("resize", resize);
  try {
    return { answer: await run(proxy), rows: resized ? null : cursor.rows() };
  } finally {
    output.off("resize", resize);
    proxy.destroy();
  }
}
