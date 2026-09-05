import { describe, expect, it } from "vitest";

import { stateFromGitRef, streamStateFromGitRef } from "./git.js";
import type { GitReader } from "./types.js";

const attributesOid = "a".repeat(40);
const blobOid = "b".repeat(40);

function readerWithInvalidTextBlob(): GitReader {
  return {
    lsTree: async () => [
      { path: ".gitattributes", mode: "100644", type: "blob", objectId: attributesOid },
      { path: "payload.txt", mode: "100644", type: "blob", objectId: blobOid }
    ],
    readBlob: async (objectId: string) =>
      objectId === attributesOid ? "*.txt text\n" : "ignored path fallback",
    readBlobBytes: async () => Uint8Array.from([0x66, 0x80, 0x67]),
    readFile: async () => {
      throw new Error("path-based fallback must not be used");
    }
  };
}

describe("Git import adversarial encoding handling", () => {
  it("fails closed when text is forced for a blob that is not valid UTF-8", async () => {
    await expect(stateFromGitRef(readerWithInvalidTextBlob(), "HEAD")).rejects.toThrow(
      /forces text but blob is not valid UTF-8/u
    );
  });

  it("keeps eager and streaming import behavior consistent for forced invalid text", async () => {
    const reader = readerWithInvalidTextBlob();
    await expect(
      (async () => {
        for await (const ignored of streamStateFromGitRef(reader, "HEAD")) {
          void ignored;
        }
      })()
    ).rejects.toThrow(/forces text but blob is not valid UTF-8/u);
  });
});
