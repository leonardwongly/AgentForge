import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileLedger } from "./ledger.js";

function withLedger(run: (file: string, ledger: FileLedger) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "loom-ledger-"));
  const file = join(dir, "ledger.jsonl");
  try {
    run(file, new FileLedger(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("tamper-evident admission ledger", () => {
  it("appends a linked chain of entries", () => {
    withLedger((_file, ledger) => {
      const first = ledger.append({ proposal: "p1", decision: "admitted" });
      const second = ledger.append({ proposal: "p2", decision: "rejected" });
      expect(first.index).toBe(0);
      expect(second.index).toBe(1);
      expect(second.prevHash).toBe(first.hash);
      expect(ledger.verify()).toEqual({ valid: true });
    });
  });

  it("detects tampering of a past payload", () => {
    withLedger((file, ledger) => {
      ledger.append({ proposal: "p1", decision: "admitted" });
      ledger.append({ proposal: "p2", decision: "rejected" });
      // Tamper with the first entry's payload on disk.
      const raw = readFileSync(file, "utf8");
      const tampered = raw.replace('"decision":"admitted"', '"decision":"REJECTED"');
      writeFileSync(file, tampered, "utf8");
      expect(ledger.verify().valid).toBe(false);
    });
  });

  it("detects reordering of entries", () => {
    withLedger((file, ledger) => {
      const a = ledger.append({ proposal: "p1" });
      const b = ledger.append({ proposal: "p2" });
      // Swap the two lines.
      const lines = readFileSync(file, "utf8").trim().split("\n");
      writeFileSync(file, `${lines[1]}\n${lines[0]}\n`, "utf8");
      expect(ledger.verify().valid).toBe(false);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  it("verifies an empty ledger", () => {
    withLedger((_file, ledger) => {
      expect(ledger.read()).toEqual([]);
      expect(ledger.verify()).toEqual({ valid: true });
    });
  });

  it("is durable across reloads", () => {
    withLedger((file, ledger) => {
      ledger.append({ proposal: "p1" });
      const reloaded = new FileLedger(file);
      expect(reloaded.read()).toHaveLength(1);
      expect(reloaded.verify()).toEqual({ valid: true });
    });
  });
});
