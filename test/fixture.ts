// fixture.ts — an in-process /api/v1/me fixture server shaped exactly like the route PR #3332 shipped.
import { createServer, type Server } from "node:http";

export const FIXTURE_ME_BODY = {
  account: "tenant-3",
  slug: "hagale-technologies",
  name: "Hagale Technologies",
  permissions: ["mirror:read", "mirror:feed"],
  principal: "service",
} as const;

export interface FixtureServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startMeFixture(
  handler?: (path: string) => { status: number; body: unknown },
): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path.startsWith("/api/v1/me")) {
      const auth = req.headers.authorization ?? null;
      const out =
        handler?.(path) ??
        (auth === "Bearer fixture-key"
          ? { status: 200, body: FIXTURE_ME_BODY }
          : { status: 401, body: { error: "unauthorized", reason: "credential-not-accepted" } });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fixture server has no port");
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
