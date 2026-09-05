import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { effectsForPath } from "./effects.js";
import { FileLedger } from "./ledger.js";
import { FileLock } from "./lock.js";
import { SessionStore } from "./session.js";
import { FileLineJournal, FileObjectStore } from "./store.js";
import {
  MULTICODEC,
  base32Decode,
  base32Encode,
  cidV1,
  decodeDagCbor,
  encodeDagCbor,
  parseCid
} from "./codec.js";
import {
  NonceReplayGuard,
  buildRequest,
  signRequest,
  validateWireMessage,
  verifyRequest
} from "./wire.js";
import type { Cid, Did } from "./types.js";

const AGENT = "did:loom:adversarial" as Did;
const SECRET = "adversarial-wire-secret";

async function withRoot<T>(prefix: string, run: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("adversarial DAG-CBOR and CID boundaries", () => {
  it("orders map keys by UTF-8 byte length and bytewise order", () => {
    const encoded = encodeDagCbor({ é: 1, aa: 2 });
    const hex = [...encoded].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    // Both keys occupy two UTF-8 bytes, so aa (61 61) sorts before é (c3 a9).
    expect(hex).toBe("a26261610262c3a901");
    const decoded = decodeDagCbor(
      Uint8Array.from([0xa2, 0x62, 0x61, 0x61, 0x02, 0x62, 0xc3, 0xa9, 0x01])
    ) as Record<string, unknown>;
    expect(decoded["aa"]).toBe(2);
    expect(decoded["é"]).toBe(1);
  });

  it("rejects lone UTF-16 surrogates and preserves full uint64 integers", () => {
    expect(() => encodeDagCbor("\ud800")).toThrow(/UTF-8|surrogate|scalar/iu);

    const positive = 0xffffffffffffffffn;
    const negative = -0x10000000000000000n;
    expect(decodeDagCbor(encodeDagCbor(positive))).toBe(positive);
    expect(decodeDagCbor(encodeDagCbor(negative))).toBe(negative);
  });

  it("rejects 64-bit allocation-bomb lengths before trying to allocate", () => {
    const hugeByteString = Uint8Array.from([0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => decodeDagCbor(hugeByteString)).toThrow();
  });

  it("accepts only canonical lowercase CIDv1 SHA-256 text", () => {
    const cid = cidV1(MULTICODEC.raw, new Uint8Array([1, 2, 3]));
    expect(parseCid(cid)).toBeDefined();
    expect(parseCid(cid.toUpperCase())).toBeUndefined();

    const altered = base32Decode(cid);
    altered[0] = 2;
    expect(parseCid(base32Encode(altered))).toBeUndefined();
  });
});

describe("adversarial wire envelope and replay limits", () => {
  it("signs semantically identical params identically regardless of insertion order", () => {
    const { request } = buildRequest("hello", { a: 1, b: 2 }, SECRET, 1_700_000_000_000);
    const reordered = { ...request, params: { b: 2, a: 1 } };
    expect(signRequest(request, SECRET)).toBe(signRequest(reordered, SECRET));
  });

  it("rejects unknown envelope fields and incomplete response payloads", () => {
    const { request } = buildRequest("hello", {}, SECRET, 1_700_000_000_000);
    expect(validateWireMessage({ ...request, unexpected: true })).toMatch(/unknown .*field/iu);
    expect(validateWireMessage({ v: 1, id: "response", ok: true })).toMatch(/result/iu);
    expect(
      validateWireMessage({
        v: 1,
        id: "error",
        ok: false,
        error: { code: "x", message: "y", extra: 1 }
      })
    ).toMatch(/unknown .*field/iu);
  });

  it("does not let direct request verification bypass nonce validation", () => {
    const { request } = buildRequest("hello", {}, SECRET, 1_700_000_000_000);
    const malformed = { ...request, nonce: "" };
    expect(
      verifyRequest(malformed, signRequest(malformed, SECRET), SECRET, 1_700_000_000_000)
    ).toMatch(/nonce/iu);
  });

  it("keeps replay nonce memory bounded while making expiry reusable", () => {
    const guard = new NonceReplayGuard();
    for (let index = 0; index < 100_000; index += 1) {
      expect(guard.claim(`nonce-${index}`, 1, 0)).toBe(true);
    }
    expect(guard.claim("overflow", 1, 0)).toBe(false);
    expect(guard.claim("after-expiry", 2, 2)).toBe(true);
    expect(guard.claim("nonce-99999", 2, 2)).toBe(true);
  });
});

describe("adversarial session, effects, and lock state", () => {
  it("clones and freezes session authorization state against caller mutation", () => {
    const store = new SessionStore();
    const scope = ["src/"];
    const session = store.create({ agentDid: AGENT, grantId: "grant", writeScope: scope });
    scope.push("secrets/");

    expect(session.writeScope).toEqual(["src/"]);
    expect(Object.isFrozen(session)).toBe(true);
    expect(() => (session.writeScope as string[]).push("secrets/")).toThrow();
    expect(Reflect.set(session as object, "writes", 100)).toBe(false);
    expect(session.writes).toBe(0);
    expect(store.canWrite(session, "secrets/key")).toBe(false);
  });

  it("normalizes Windows separators before classifying CI and test paths", () => {
    expect(effectsForPath(String.raw`.github\workflows\ci.yml`, "modified")).toEqual([
      "changes_ci"
    ]);
    expect(effectsForPath(String.raw`tests\unit\parser.test.ts`, "modified")).toEqual([
      "skips_test"
    ]);
  });

  it("keeps each lock release closure tied to its own acquisition", async () => {
    await withRoot("loom-lock-adversarial-", async (root) => {
      const lock = new FileLock(root, "same", 30_000, 500);
      const releaseFirst = await lock.acquire();
      const second = lock.acquire();
      releaseFirst();
      const releaseSecond = await second;

      // Calling an old release handle must not release the newer owner.
      releaseFirst();
      expect(existsSync(join(root, "locks", "same.lock"))).toBe(true);
      releaseSecond();
      expect(existsSync(join(root, "locks", "same.lock"))).toBe(false);
    });
  });
});

describe("adversarial durable state and journal handling", () => {
  it("fails closed on a non-object ledger record instead of throwing", async () => {
    await withRoot("loom-ledger-adversarial-", (root) => {
      const file = join(root, "ledger.jsonl");
      writeFileSync(file, "null\n", "utf8");
      expect(new FileLedger(file).verify()).toEqual({ valid: false, firstInvalid: 0 });
    });
  });

  it("filters malformed object filenames from CID inventory", async () => {
    await withRoot("loom-store-adversarial-", (root) => {
      const store = new FileObjectStore(root);
      const valid = store.putRaw(new Uint8Array([1, 2, 3]));
      writeFileSync(join(root, "objects", `${"a".repeat(20)}.bin`), Buffer.from([4]), "binary");
      writeFileSync(join(root, "objects", "not-a-cid.bin"), Buffer.from([5]), "binary");

      expect(store.listCids()).toEqual([valid]);
    });
  });

  it("repairs a corrupt immutable object when the same content is put again", async () => {
    await withRoot("loom-store-repair-", (root) => {
      const store = new FileObjectStore(root);
      const value = { stable: true };
      const cid = store.put(value);
      writeFileSync(
        join(root, "objects", `${cid}.json`),
        JSON.stringify({ stable: false }),
        "utf8"
      );

      expect(store.put(value)).toBe(cid);
      expect(store.get(cid)).toEqual(value);
    });
  });

  it("does not follow a live-object symlink during restore", async () => {
    await withRoot("loom-store-symlink-", (root) => {
      const store = new FileObjectStore(root);
      const cid = store.putRaw(new Uint8Array([7, 8, 9]));
      const backup = join(root, "backup");
      store.backupTo(backup);
      const outside = join(root, "outside.bin");
      writeFileSync(outside, "do not overwrite", "utf8");
      rmSync(join(root, "objects", `${cid}.bin`));
      symlinkSync(outside, join(root, "objects", `${cid}.bin`));

      expect(() => store.restoreFrom(backup)).toThrow(/symlink|regular|object/iu);
      expect(readFileSync(outside, "utf8")).toBe("do not overwrite");
    });
  });

  it("rejects advancement over a corrupt line instead of treating it as genesis", async () => {
    await withRoot("loom-journal-corrupt-", async (root) => {
      const journal = new FileLineJournal(root);
      writeFileSync(join(root, "lines", "main.json"), "not-json\n", "utf8");

      await expect(
        journal.advance({
          name: "main",
          scope: "shared",
          expectedHead: "genesis" as Cid,
          expectedSequence: 0,
          newHead: "next" as Cid
        })
      ).rejects.toThrow(/corrupt|invalid/iu);
      expect(readFileSync(join(root, "lines", "main.json"), "utf8")).toBe("not-json\n");
    });
  });

  it("rejects duplicate line names in one batch rather than writing two stale entries", async () => {
    await withRoot("loom-journal-batch-", async (root) => {
      const journal = new FileLineJournal(root);
      const genesis = "genesis" as Cid;
      await journal.advance({
        name: "main",
        scope: "shared",
        expectedHead: genesis,
        expectedSequence: 0,
        newHead: "head-0" as Cid
      });

      const result = await journal.advanceBatch([
        {
          name: "main",
          scope: "shared",
          expectedHead: "head-0" as Cid,
          expectedSequence: 0,
          newHead: "head-1" as Cid
        },
        {
          name: "main",
          scope: "shared",
          expectedHead: "head-0" as Cid,
          expectedSequence: 0,
          newHead: "head-2" as Cid
        }
      ]);
      expect(result).toMatchObject({ ok: false, reason: "conflict", failedLine: "main" });
      expect(journal.read("main")).toMatchObject({ head: "head-0", sequence: 0 });
    });
  });

  it("rejects forged idempotency records instead of returning attacker state", async () => {
    await withRoot("loom-journal-idem-", async (root) => {
      const journal = new FileLineJournal(root);
      const key = "request-key";
      const input = {
        name: "main",
        scope: "shared" as const,
        expectedHead: "genesis" as Cid,
        expectedSequence: 0,
        newHead: "honest" as Cid,
        idempotencyKey: key
      };
      const digest = createHash("sha256")
        .update(
          JSON.stringify({
            name: input.name,
            scope: input.scope,
            expectedHead: input.expectedHead,
            expectedSequence: input.expectedSequence,
            newHead: input.newHead
          })
        )
        .digest("hex");
      writeFileSync(
        join(root, "idempotency", `${encodeURIComponent(key)}.json`),
        JSON.stringify({
          digest,
          entry: { name: "main", scope: "shared", head: "forged", sequence: 999 }
        }),
        "utf8"
      );

      await expect(journal.advance(input)).rejects.toThrow(/idempotency|corrupt|invalid/iu);
      expect(journal.read("main")).toBeUndefined();
    });
  });
});
