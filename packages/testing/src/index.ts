import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PullRequestInput } from "@agentforge/core";

export async function loadFixturePr(filePath: string): Promise<PullRequestInput> {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content) as PullRequestInput;
}

export function fixturePath(...segments: string[]): string {
  return path.resolve(process.cwd(), "fixtures", ...segments);
}
