// env-fixture-repo.ts — a small repository tree carrying every source shape the ticket's acceptance
// criteria name (a .env.example, a GitHub workflow using secrets.X, a wrangler.toml binding, a
// process.env.Y read), plus a real .env carrying sentinel values for the no-value tests. Materialised
// with mkdtempSync rather than checked in as a literal tree, so a file literally named ".env" never
// enters the git history.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SENTINELS = ["SENTINEL-DB-VALUE-9f3a", "SENTINEL-URL-7c21"];

// C-1/S-1 (CTC-2496 validate attempt 7): a `.env.example`-family file may carry a MULTI-LINE quoted
// value — a PEM key is the common real case. Its continuation lines are shaped exactly like an
// assignment (an identifier run, then "="), so a line-oriented scanner emits the value as a NAME.
// Alphanumeric on purpose: the sentinel has to survive the scanner's own [A-Za-z0-9_] capture to
// prove the leak, and this is the fixture the no-value test's positive control reads back.
export const MULTILINE_VALUE_SENTINEL = "SENTINELPEMBODY7b41";

export const ENV_FIXTURE_FILES: Record<string, string> = {
  ".env.example": ["DATABASE_URL=", "export API_BASE_URL=https://example.test", "#OPTIONAL_FLAG=", "", "# just a comment about SOMETHING"].join("\n"),
  ".env": [`DATABASE_URL=postgres://user:${SENTINELS[0]}@localhost/app`, `API_BASE_URL=https://${SENTINELS[1]}.example`].join("\n"),
  ".github/workflows/ci.yml": [
    "name: CI",
    "on: push",
    "env:",
    "  CI_GLOBAL_TOKEN: ${{ secrets.GLOBAL_TOKEN }}",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    env:",
    "      NODE_ENV: test",
    "    steps:",
    "      - run: npm test",
    "        env:",
    "          DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}",
    "  ship:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    '      - run: echo "we do not deploy here"',
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    environment: production",
    "    steps:",
    "      - run: npx wrangler deploy",
    "        env:",
    "          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "          NPM_PUBLISH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}",
    "",
  ].join("\n"),
  ".github/workflows/hard.yml": [
    "name: Hard",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    env: { FLOW_ONE: a, FLOW_TWO: b }",
    "    steps:",
    "      - run: |",
    "          echo not env: NOT_A_NAME=1",
    "          echo ${{ secrets.INSIDE_BLOCK }}",
    "",
  ].join("\n"),
  "wrangler.toml": [
    "name = \"my-worker\"",
    "",
    "[vars]",
    'PUBLIC_MODE = "on"',
    'MULTI = """',
    "a = not_a_name",
    '"""',
    "",
    "[[kv_namespaces]]",
    'binding = "SESSIONS"',
    'id = "abc123"',
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    'database_id = "def456"',
    "",
    "[[durable_objects.bindings]]",
    'name = "COUNTER"',
    'class_name = "Counter"',
    "",
    "[env.production.vars]",
    'PROD_ONLY = "yes"',
    "",
    "[[env.production.kv_namespaces]]",
    'binding = "PROD_SESSIONS"',
    'id = "ghi789"',
    "",
  ].join("\n"),
  ".env.defaults": [
    'GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
    "MIIEvQIBADANBgkqhkiGkO1De7zhZQCqGKukO1De7zhZ",
    `j6bFlvQ6${MULTILINE_VALUE_SENTINEL}CqOH0RhKQ=`,
    '-----END PRIVATE KEY-----"',
    "PLAIN_AFTER_KEY=",
    "",
  ].join("\n"),
  "src/index.ts": ['const a = process.env.STRIPE_SECRET_KEY;', 'const b = process.env["DATABASE_URL"];', "console.log(a, b);"].join("\n"),
};

/** Writes ENV_FIXTURE_FILES (plus any extra) into a fresh temp directory and returns its root. */
export function writeFixtureRepo(extra: Record<string, string> = {}): string {
  const root = mktemp();
  for (const [rel, contents] of Object.entries({ ...ENV_FIXTURE_FILES, ...extra })) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function mktemp(): string {
  return mkdtempSync(join(tmpdir(), "catalyst-env-fixture-"));
}
