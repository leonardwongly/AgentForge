import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const apiSourceRoot = join(process.cwd(), "apps/api/src");

describe("persistence boundary", () => {
  it("keeps API handler support code free of direct Prisma branching", () => {
    const sources = ["app.ts", "routes/api-routes.ts"].map((file) => ({
      file,
      content: readFileSync(join(apiSourceRoot, file), "utf8")
    }));

    for (const source of sources) {
      expect(source.content, `${source.file} should not branch on missing Prisma`).not.toMatch(
        /if\s*\(\s*!\s*prisma\s*\)/u
      );
      expect(source.content, `${source.file} should not branch on present Prisma`).not.toMatch(
        /if\s*\(\s*prisma\s*\)/u
      );
    }
  });
});
