import { describe, expect, it } from "vitest";

import { effectsForPath, effectsFromChangeJournal } from "./effects.js";

describe("effectsForPath", () => {
  it("classifies test, CI, sensitive, and source paths", () => {
    expect(effectsForPath("src/x.test.ts", "modified")).toEqual(["skips_test"]);
    expect(effectsForPath("src/x.test.ts", "removed")).toEqual(["deletes_test"]);
    expect(effectsForPath(".github/workflows/ci.yml", "modified")).toEqual(["changes_ci"]);
    expect(effectsForPath("src/billing/checkout.ts", "modified")).toEqual(["touches_sensitive_path"]);
    expect(effectsForPath("src/app.ts", "modified")).toEqual(["edits_source"]);
    expect(effectsForPath("src/app.ts", "removed")).toEqual(["deletes_source"]);
  });
});

describe("effectsFromChangeJournal", () => {
  it("derives a deduplicated effect set from a change journal", () => {
    const effects = effectsFromChangeJournal({
      added: ["src/billing/new.ts"],
      modified: ["src/app.ts", ".github/workflows/ci.yml"],
      removed: ["src/old.test.ts"]
    });
    expect(effects.sort()).toEqual([
      "changes_ci",
      "deletes_test",
      "edits_source",
      "touches_sensitive_path"
    ]);
  });

  it("returns no effects for an empty journal", () => {
    expect(effectsFromChangeJournal({ added: [], modified: [], removed: [] })).toEqual([]);
  });
});
