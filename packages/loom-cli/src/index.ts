#!/usr/bin/env node
/** loom CLI entry: wires the real filesystem + git reader into {@link main}. */
import { readFileSync } from "node:fs";
import process from "node:process";

import { execGitReader } from "@agentforge/loom-git-bridge";

import { createNodeAtomicWriteOperations } from "./atomic-fs.js";
import { createAtomicFileWriter, main, type CliIo } from "./main.js";

const io: CliIo = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFilesAtomically: createAtomicFileWriter(createNodeAtomicWriteOperations()),
  makeReader: (repoDir) => execGitReader(repoDir),
  log: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`)
};

main(process.argv.slice(2), io)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
