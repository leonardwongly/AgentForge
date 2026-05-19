import { spawn } from "node:child_process";
import { acquireE2eLock, runE2ePreflight } from "./e2e-preflight.js";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const playwright = process.platform === "win32" ? "playwright.cmd" : "playwright";

async function main(): Promise<void> {
  const releaseLock = await acquireE2eLock();
  try {
    await runE2ePreflight({ skipE2eLockCheck: true });
    await runCommand(pnpm, ["--filter", "@agentforge/web", "build"]);
    await runE2ePreflight({
      requireBuild: true,
      skipE2eLockCheck: true,
      skipPortCheck: true
    });
    await runCommand(playwright, ["test", ...process.argv.slice(2)]);
  } finally {
    await releaseLock();
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} failed with ${signal ?? `exit code ${code}`}.`)
      );
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
