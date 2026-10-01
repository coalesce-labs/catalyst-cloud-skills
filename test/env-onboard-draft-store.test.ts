import {
  lstatSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  storeOnboardDraft,
  type OnboardDraftStoreFs,
} from "../src/env/onboard-draft-store.js";

const homes: string[] = [];

function fixture() {
  const home = realpathSync(
    mkdtempSync(join(tmpdir(), "onboard-draft-store-")),
  );
  homes.push(home);
  const stateRoot = join(home, "state");
  return {
    home,
    stateRoot,
    env: { CATALYST_INSTALL_STATE_DIR: stateRoot } as NodeJS.ProcessEnv,
  };
}

afterEach(() => {
  // Test-owned temporary fixtures are under the unique mkdtemp path.
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("storeOnboardDraft", () => {
  it.each([
    "state",
    "state/install",
    "state/install/drafts",
    "state/install/drafts/run",
  ])(
    "rejects writable storage ancestor %s without changing its permissions",
    async (relative) => {
      const f = fixture();
      const unsafe = join(f.home, relative);
      mkdirSync(unsafe, { recursive: true, mode: 0o700 });
      chmodSync(unsafe, 0o777);
      expect(
        await storeOnboardDraft({
          home: f.home,
          env: f.env,
          runId: "run",
          repoId: "repo",
          toml: "[project]\n",
        }),
      ).toEqual({ state: "rejected" });
      expect(lstatSync(unsafe).mode & 0o777).toBe(0o777);
    },
  );
  it.each([
    "state",
    "state/install",
    "state/install/drafts",
    "state/install/drafts/run",
  ])("rejects a foreign-owned storage ancestor %s", async (relative) => {
    const f = fixture();
    const foreign = join(f.home, relative);
    mkdirSync(foreign, { recursive: true, mode: 0o700 });
    const fsOps: OnboardDraftStoreFs = {
      ...fsPromises,
      lstat: (async (path, options) => {
        const stat = await fsPromises.lstat(path, options);
        if (String(path) === foreign) stat.uid = (process.getuid?.() ?? 0) + 1;
        return stat;
      }) as typeof fsPromises.lstat,
    };
    expect(
      await storeOnboardDraft(
        {
          home: f.home,
          env: f.env,
          runId: "run",
          repoId: "repo",
          toml: "[project]\n",
        },
        fsOps,
      ),
    ).toEqual({ state: "rejected" });
  });

  it("stores a private value-free draft beneath the canonical onboarding state root", async () => {
    const f = fixture();
    const result = await storeOnboardDraft({
      home: f.home,
      env: f.env,
      runId: "run_123",
      repoId: "repo-ABC",
      toml: '[project]\nlinear_team = "CTC"\n',
    });

    expect(result).toEqual({
      state: "stored",
      path: join(f.stateRoot, "install", "drafts", "run_123", "repo-ABC.toml"),
    });
    if (result.state !== "stored") throw new Error("expected stored draft");
    expect(readFileSync(result.path, "utf8")).toBe(
      '[project]\nlinear_team = "CTC"\n',
    );
    expect(lstatSync(result.path).mode & 0o777).toBe(0o600);
    for (const path of [
      f.stateRoot,
      join(f.stateRoot, "install"),
      join(f.stateRoot, "install", "drafts"),
      join(f.stateRoot, "install", "drafts", "run_123"),
    ]) {
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
    }
  });

  it("does not change permissions on preexisting customer directories", async () => {
    const f = fixture();
    mkdirSync(f.stateRoot, { mode: 0o755 });

    const result = await storeOnboardDraft({
      home: f.home,
      env: f.env,
      runId: "run",
      repoId: "repo",
      toml: "[project]\n",
    });

    expect(result.state).toBe("stored");
    expect(lstatSync(f.stateRoot).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(f.stateRoot, "install")).mode & 0o777).toBe(0o700);
  });

  it("reuses an exact existing private artifact for resume", async () => {
    const f = fixture();
    const dir = join(f.stateRoot, "install", "drafts", "run_123");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "repo.toml");
    writeFileSync(path, "preserve-existing\n", { mode: 0o600 });

    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run_123",
        repoId: "repo",
        toml: "preserve-existing\n",
      }),
    ).resolves.toEqual({ state: "stored", path });
    expect(readFileSync(path, "utf8")).toBe("preserve-existing\n");
  });

  it("allows partial-batch retry for an exact file and preserves a different collision", async () => {
    const f = fixture();
    const dir = join(f.stateRoot, "install", "drafts", "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const exactPath = join(dir, "repo-exact.toml");
    const otherPath = join(dir, "repo-other.toml");
    writeFileSync(exactPath, "exact\n", { mode: 0o600 });
    writeFileSync(otherPath, "keep-different\n", { mode: 0o600 });

    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo-exact",
        toml: "exact\n",
      }),
    ).resolves.toEqual({ state: "stored", path: exactPath });
    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo-other",
        toml: "new\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(readFileSync(otherPath, "utf8")).toBe("keep-different\n");
  });

  it.each([
    ["empty run id", "", "repo"],
    ["path traversal run id", "../outside", "repo"],
    ["separator repo id", "run", "../outside"],
    ["oversized repo id", "run", `r${"a".repeat(128)}`],
  ])("rejects %s before creating state", async (_case, runId, repoId) => {
    const f = fixture();
    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId,
        repoId,
        toml: "[project]\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(() => lstatSync(f.stateRoot)).toThrow();
  });

  it("rejects an aborted operation before creating state", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "[project]\n",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(() => lstatSync(f.stateRoot)).toThrow();
  });

  it("settles close and removes only its created file when cancellation arrives after close", async () => {
    const f = fixture();
    const controller = new AbortController();
    const fsOps: OnboardDraftStoreFs = {
      mkdir: fsPromises.mkdir,
      lstat: fsPromises.lstat,
      unlink: fsPromises.unlink,
      open: (async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await fsPromises.open(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          controller.abort();
        };
        return handle;
      }) as typeof fsPromises.open,
    };
    const result = await storeOnboardDraft(
      {
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "exact\n",
        signal: controller.signal,
      },
      fsOps,
    );

    expect(result).toEqual({ state: "rejected" });
    expect(() =>
      lstatSync(join(f.stateRoot, "install", "drafts", "run", "repo.toml")),
    ).toThrow();
  });

  it("checks cancellation after an asynchronous directory creation settles", async () => {
    const f = fixture();
    const controller = new AbortController();
    const fsOps: OnboardDraftStoreFs = {
      ...fsPromises,
      mkdir: (async (...args: Parameters<typeof fsPromises.mkdir>) => {
        const result = await fsPromises.mkdir(...args);
        controller.abort();
        return result;
      }) as typeof fsPromises.mkdir,
    };
    const result = await storeOnboardDraft(
      {
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "draft\n",
        signal: controller.signal,
      },
      fsOps,
    );

    expect(result).toEqual({ state: "rejected" });
    expect(() =>
      lstatSync(join(f.stateRoot, "install", "drafts", "run", "repo.toml")),
    ).toThrow();
  });

  it("cleans its created inode when cancellation arrives after fsync settles", async () => {
    const f = fixture();
    const controller = new AbortController();
    const fsOps: OnboardDraftStoreFs = {
      ...fsPromises,
      open: (async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await fsPromises.open(...args);
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          controller.abort();
        };
        return handle;
      }) as typeof fsPromises.open,
    };
    const result = await storeOnboardDraft(
      {
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "draft\n",
        signal: controller.signal,
      },
      fsOps,
    );

    expect(result).toEqual({ state: "rejected" });
    expect(() =>
      lstatSync(join(f.stateRoot, "install", "drafts", "run", "repo.toml")),
    ).toThrow();
  });

  it("preserves an exact existing file when cancellation arrives after resume close", async () => {
    const f = fixture();
    const dir = join(f.stateRoot, "install", "drafts", "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "repo.toml");
    writeFileSync(path, "exact\n", { mode: 0o600 });
    const controller = new AbortController();
    const fsOps: OnboardDraftStoreFs = {
      mkdir: fsPromises.mkdir,
      lstat: fsPromises.lstat,
      unlink: fsPromises.unlink,
      open: (async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await fsPromises.open(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          controller.abort();
        };
        return handle;
      }) as typeof fsPromises.open,
    };

    await expect(
      storeOnboardDraft(
        {
          home: f.home,
          env: f.env,
          runId: "run",
          repoId: "repo",
          toml: "exact\n",
          signal: controller.signal,
        },
        fsOps,
      ),
    ).resolves.toEqual({ state: "rejected" });
    expect(readFileSync(path, "utf8")).toBe("exact\n");
  });

  it("rejects a symlinked state root without writing through it", async () => {
    const f = fixture();
    const target = join(f.home, "target-state");
    mkdirSync(target);
    symlinkSync(target, f.stateRoot);

    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "[project]\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(lstatSync(f.stateRoot).isSymbolicLink()).toBe(true);
    expect(() => lstatSync(join(target, "install"))).toThrow();
  });

  it("rejects a symlinked ancestor below the state root", async () => {
    const f = fixture();
    const redirect = join(f.home, "redirect");
    mkdirSync(f.stateRoot, { mode: 0o700 });
    mkdirSync(redirect);
    symlinkSync(redirect, join(f.stateRoot, "install"));

    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "[project]\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(() => lstatSync(join(redirect, "drafts"))).toThrow();
  });

  it("rejects an existing symlink at the artifact path and preserves its target", async () => {
    const f = fixture();
    const dir = join(f.stateRoot, "install", "drafts", "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(f.home, "keep.toml");
    writeFileSync(target, "keep-this\n");
    const path = join(dir, "repo.toml");
    symlinkSync(target, path);

    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "[project]\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep-this\n");
  });

  it("rejects hardlinked and non-private existing artifacts without changing them", async () => {
    const f = fixture();
    const dir = join(f.stateRoot, "install", "drafts", "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "repo.toml");
    const linked = join(f.home, "linked-copy");
    writeFileSync(path, "same\n", { mode: 0o600 });
    const { linkSync, chmodSync } = await import("node:fs");
    linkSync(path, linked);
    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "same\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(readFileSync(path, "utf8")).toBe("same\n");

    linkSync(path, join(f.home, "remove-hardlink"));
    const { unlinkSync } = await import("node:fs");
    unlinkSync(linked);
    unlinkSync(join(f.home, "remove-hardlink"));
    chmodSync(path, 0o644);
    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "same\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(readFileSync(path, "utf8")).toBe("same\n");
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
  });

  it("rejects a directory at the artifact path without changing it", async () => {
    const f = fixture();
    const dir = join(f.stateRoot, "install", "drafts", "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "repo.toml");
    mkdirSync(path);

    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "[project]\n",
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(lstatSync(path).isDirectory()).toBe(true);
  });

  it("rejects non-string and over-limit TOML without creating state", async () => {
    const f = fixture();
    await expect(
      storeOnboardDraft({
        home: f.home,
        env: f.env,
        runId: "run",
        repoId: "repo",
        toml: "x".repeat(1024 * 1024 + 1),
      }),
    ).resolves.toEqual({ state: "rejected" });
    expect(() => lstatSync(f.stateRoot)).toThrow();
  });
});
