/**
 * @agentforge/loom-git-bridge — git → Loom {@link State} building.
 *
 * The pure state-building logic sits behind the {@link GitReader} port so it is
 * unit-testable with a fake reader (no real repo); {@link execGitReader} is the
 * real, shell-free implementation over the `git` CLI via node:child_process.
 *
 * Identity is path-derived (see {@link nodeIdentForPath}): git has no intrinsic
 * node identity, so a stable path keeps a stable NodeIdent across refs (a
 * downstream diff then reads a content change as "modified"), while a different
 * path yields a different ident (delete+add, matching git's default).
 */
import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { sha256Hex, type Cell, type NodeIdent, type State } from "@agentforge/loom-core";
import { facetFromAttributes, parseGitAttributes, type GitAttributes } from "./gitattributes.js";
import type { GitReader, GitTreeEntry, TransformStates } from "./types.js";

/** Upper bound for captured git stdout (bytes); large enough for big blobs/trees. */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LS_TREE_METADATA = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/;

function decodeUtf8(bytes: Uint8Array, subject: string): string {
  try {
    // fatal prevents invalid bytes from aliasing valid U+FFFD content. Treat a
    // leading BOM as content as well, rather than silently dropping it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`loom-git-bridge: ${subject} is not valid UTF-8`);
  }
}

function parseLsTree(output: Buffer): ReadonlyArray<GitTreeEntry> {
  const entries: GitTreeEntry[] = [];
  let offset = 0;

  while (offset < output.length) {
    const nulIndex = output.indexOf(0, offset);
    if (nulIndex === -1) {
      throw new Error("loom-git-bridge: malformed git ls-tree output (missing NUL terminator)");
    }

    const record = output.subarray(offset, nulIndex);
    offset = nulIndex + 1;
    const tabIndex = record.indexOf(0x09);
    if (tabIndex === -1) {
      throw new Error("loom-git-bridge: malformed git ls-tree output (missing metadata separator)");
    }

    const metadata = decodeUtf8(record.subarray(0, tabIndex), "ls-tree metadata");
    const match = LS_TREE_METADATA.exec(metadata);
    if (match === null) {
      throw new Error("loom-git-bridge: malformed git ls-tree metadata");
    }

    const mode = match[1];
    const gitType = match[2];
    const objectId = match[3];
    if (mode === undefined || gitType === undefined || objectId === undefined) {
      throw new Error("loom-git-bridge: malformed git ls-tree metadata");
    }

    const path = decodeUtf8(record.subarray(tabIndex + 1), `path for object ${objectId}`);
    if (path.length === 0) {
      throw new Error("loom-git-bridge: malformed git ls-tree output (empty path)");
    }

    entries.push({
      path,
      mode,
      type: gitType === "blob" ? "blob" : gitType === "commit" ? "commit" : "tree",
      objectId
    });
  }

  return entries;
}

/**
 * Deterministically derive a Cell's stable identity from its path. The same
 * path always maps to the same ident (enabling "modified" detection across
 * refs); distinct paths map to distinct idents (delete+add).
 */
export function nodeIdentForPath(path: string): NodeIdent {
  return ("nid:" + sha256Hex(path).slice(0, 32)) as NodeIdent;
}

/**
 * Build a Loom {@link State} from a single git ref. Text blobs become `text`
 * Cells; binary blobs and submodules become `bytes` Cells so they are preserved
 * and round-trip instead of being dropped or throwing on strict UTF-8 decode.
 * Tree entries are skipped.
 */
export async function stateFromGitRef(reader: GitReader, ref: string): Promise<State> {
  const entries = await reader.lsTree(ref);
  const attributes = await readGitAttributes(reader, ref);
  const cells = Object.create(null) as Record<string, Cell>;
  for (const entry of entries) {
    if (entry.type === "tree") {
      continue;
    }
    if (entry.type === "commit") {
      // Submodule: preserve the pinned commit OID so it round-trips.
      cells[entry.path] = {
        facet: "bytes",
        ident: nodeIdentForPath(entry.path),
        text: entry.objectId ?? ""
      };
      continue;
    }
    const forcedFacet = attributes === undefined ? undefined : facetFromAttributes(attributes, entry.path);
    // blob
    if (entry.objectId !== undefined && reader.readBlobBytes !== undefined) {
      const bytes = await reader.readBlobBytes(entry.objectId);
      const text = tryUtf8(bytes);
      if (forcedFacet === "bytes" || (forcedFacet === undefined && text === undefined)) {
        cells[entry.path] = {
          facet: "bytes",
          ident: nodeIdentForPath(entry.path),
          text: Buffer.from(bytes).toString("base64")
        };
      } else {
        cells[entry.path] = { facet: "text", ident: nodeIdentForPath(entry.path), text: text ?? "" };
      }
      continue;
    }
    const text =
      entry.objectId !== undefined && reader.readBlob !== undefined
        ? await reader.readBlob(entry.objectId)
        : await reader.readFile(ref, entry.path);
    cells[entry.path] = {
      facet: forcedFacet === "bytes" ? "bytes" : "text",
      ident: nodeIdentForPath(entry.path),
      text: forcedFacet === "bytes" ? Buffer.from(text, "utf8").toString("base64") : text
    };
  }
  return { kind: "state", cells };
}

/** Read and parse `.gitattributes` from a ref, or undefined if absent. */
async function readGitAttributes(reader: GitReader, ref: string): Promise<GitAttributes | undefined> {
  try {
    const content =
      reader.readBlob !== undefined
        ? await reader.readBlob(await objectIdForPath(reader, ref, ".gitattributes"))
        : await reader.readFile(ref, ".gitattributes");
    return parseGitAttributes(content);
  } catch {
    return undefined;
  }
}

async function objectIdForPath(reader: GitReader, ref: string, path: string): Promise<string> {
  const entries = await reader.lsTree(ref);
  const entry = entries.find((item) => item.path === path);
  if (entry?.objectId === undefined) {
    throw new Error(`loom-git-bridge: no object id for ${path}`);
  }
  return entry.objectId;
}

/** Decode bytes as strict UTF-8; returns undefined for non-UTF-8 (binary) content. */
function tryUtf8(bytes: Uint8Array): string | undefined {
  try {
    return decodeUtf8(bytes, "blob");
  } catch {
    return undefined;
  }
}

/** Build the {base, result} state pair the Loom ratify path consumes. */
export async function transformSetFromGit(
  reader: GitReader,
  baseRef: string,
  headRef: string
): Promise<TransformStates> {
  const [base, result, renames] = await Promise.all([
    stateFromGitRef(reader, baseRef),
    stateFromGitRef(reader, headRef),
    reader.detectRenames !== undefined ? reader.detectRenames(baseRef, headRef) : Promise.resolve([])
  ]);

  // Preserve identity across renames: a renamed cell keeps its base NodeIdent,
  // so a downstream diff reads it as a move rather than delete+add.
  if (renames.length > 0) {
    const cells = { ...result.cells };
    for (const { from, to } of renames) {
      const baseCell = base.cells[from];
      const resultCell = cells[to];
      if (baseCell !== undefined && resultCell !== undefined) {
        cells[to] = { ...resultCell, ident: baseCell.ident };
      }
    }
    return { base, result: { kind: "state", cells } };
  }
  return { base, result };
}

/**
 * Real {@link GitReader} over the `git` CLI. Uses execFileSync with an argument
 * array (never a shell string). Git output remains bytes until it is decoded as
 * strict UTF-8, and tree paths use NUL-delimited, non-quoted records.
 */
export function execGitReader(repoDir: string): GitReader {
  function runGit(args: ReadonlyArray<string>): Buffer {
    try {
      return execFileSync("git", ["-C", repoDir, ...args], {
        maxBuffer: GIT_MAX_BUFFER
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`loom-git-bridge: \`git ${args.join(" ")}\` failed: ${detail}`);
    }
  }

  function readBlob(objectId: string): Promise<string> {
    if (!FULL_OBJECT_ID.test(objectId)) {
      throw new Error("loom-git-bridge: invalid full Git object ID");
    }
    return Promise.resolve(decodeUtf8(runGit(["cat-file", "blob", objectId]), `blob ${objectId}`));
  }

  function readBlobBytes(objectId: string): Promise<Uint8Array> {
    if (!FULL_OBJECT_ID.test(objectId)) {
      throw new Error("loom-git-bridge: invalid full Git object ID");
    }
    return Promise.resolve(runGit(["cat-file", "blob", objectId]));
  }

  function detectRenames(baseRef: string, headRef: string): Promise<ReadonlyArray<{ from: string; to: string }>> {
    // `--name-status -z` emits NUL-delimited records; a rename is `R<score>\0<old>\0<new>\0`.
    const out = runGit(["diff", "--find-renames", "--name-status", "-z", baseRef, headRef]);
    const renames: Array<{ from: string; to: string }> = [];
    let offset = 0;
    while (offset < out.length) {
      const nulIndex = out.indexOf(0, offset);
      if (nulIndex === -1) {
        break;
      }
      const status = decodeUtf8(out.subarray(offset, nulIndex), "diff status");
      offset = nulIndex + 1;
      if (status.startsWith("R")) {
        const oldEnd = out.indexOf(0, offset);
        if (oldEnd === -1) {
          break;
        }
        const from = decodeUtf8(out.subarray(offset, oldEnd), "rename old path");
        offset = oldEnd + 1;
        const newEnd = out.indexOf(0, offset);
        if (newEnd === -1) {
          break;
        }
        const to = decodeUtf8(out.subarray(offset, newEnd), "rename new path");
        offset = newEnd + 1;
        renames.push({ from, to });
      } else {
        // Non-rename statuses carry a single path; skip it.
        const pathEnd = out.indexOf(0, offset);
        if (pathEnd === -1) {
          break;
        }
        offset = pathEnd + 1;
      }
    }
    return Promise.resolve(renames);
  }

  return {
    lsTree(ref: string): Promise<ReadonlyArray<GitTreeEntry>> {
      return Promise.resolve(parseLsTree(runGit(["ls-tree", "-r", "-z", "--full-tree", ref])));
    },
    readBlob,
    readBlobBytes,
    detectRenames,
    readFile(ref: string, path: string): Promise<string> {
      const subject = `blob ${ref}:${path}`;
      return Promise.resolve(decodeUtf8(runGit(["show", `${ref}:${path}`]), subject));
    }
  };
}
