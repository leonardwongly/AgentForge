import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileLock } from "./lock.js";

function withRoot(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "loom-lock-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

describe("FileLock", () => {
  it("acquires and releases a lock", async () => {
    await withRoot(async (root) => {
      const lock = new FileLock(root, "main");
      const release = await lock.acquire();
      expect(existsSync(join(root, "locks", "main.lock"))).toBe(true);
      release();
      expect(existsSync(join(root, "locks", "main.lock"))).toBe(false);
    });
  });

  it("blocks a second acquirer while the lock is held", async () => {
    await withRoot(async (root) => {
      const first = new FileLock(root, "main", 30_000, 500);
      const second = new FileLock(root, "main", 30_000, 500);
      const release = await first.acquire();

      let secondAcquired = false;
      const pending = second.acquire().then((rel) => {
        secondAcquired = true;
        rel();
      });

      // Give the second acquirer a moment; it must still be blocked.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(secondAcquired).toBe(false);

      release();
      await pending;
      expect(secondAcquired).toBe(true);
    });
  });

  it("steals a stale lock left by a crashed holder", async () => {
    await withRoot(async (root) => {
      const lock = new FileLock(root, "main", 100, 500);
      // Simulate a crashed holder: create the lock file with an old mtime.
      const lockPath = join(root, "locks", "main.lock");
      writeFileSync(lockPath, "{}", "utf8");
      const old = new Date(Date.now() - 10_000);
      utimesSync(lockPath, old, old);

      const release = await lock.acquire();
      expect(existsSync(lockPath)).toBe(true);
      release();
    });
  });

  it("does not let a stolen holder release the new owner's lock", async () => {
    await withRoot(async (root) => {
      const first = new FileLock(root, "main", 100, 500);
      const second = new FileLock(root, "main", 100, 500);
      const releaseFirst = await first.acquire();
      const lockPath = join(root, "locks", "main.lock");
      const old = new Date(Date.now() - 10_000);
      utimesSync(lockPath, old, old);
      const releaseSecond = await second.acquire();
      releaseFirst();
      expect(existsSync(lockPath)).toBe(true);
      releaseSecond();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  it("times out rather than waiting forever on a live lock", async () => {
    await withRoot(async (root) => {
      const holder = new FileLock(root, "main", 30_000, 10_000);
      const contender = new FileLock(root, "main", 30_000, 100);
      const release = await holder.acquire();
      await expect(contender.acquire()).rejects.toThrow(/timed out/);
      release();
    });
  });

  it("allows only one contender to win a simultaneous stale-lock steal", async () => {
    await withRoot(async (root) => {
      const lockPath = join(root, "locks", "main.lock");
      mkdirSync(join(root, "locks"), { recursive: true });
      writeFileSync(lockPath, "{}", "utf8");
      const old = new Date(Date.now() - 10_000);
      utimesSync(lockPath, old, old);

      const contenders = [new FileLock(root, "main", 100, 500), new FileLock(root, "main", 100, 500)];
      const releases = await Promise.all(contenders.map((lock) => lock.acquire()));

      expect(existsSync(lockPath)).toBe(true);
      expect(existsSync(`${lockPath}.retired.`)).toBe(false);
      const retiredFiles = readdirSync(join(root, "locks")).filter((file) => file.includes(".retired."));
      expect(retiredFiles).toHaveLength(0);

      releases.forEach((release) => release());
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
