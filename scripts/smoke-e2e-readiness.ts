const appBaseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3100";
const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:4100";

async function main(): Promise<void> {
  await assertReachable(`${apiBaseUrl}/health`, "API health");
  await assertReachable(appBaseUrl, "web app");
  console.log(`E2E readiness passed for API ${apiBaseUrl} and web ${appBaseUrl}.`);
}

async function assertReachable(url: string, label: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`${label} at ${url} returned ${response.status} ${response.statusText}.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
