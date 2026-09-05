import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  assertDistinctPorts,
  assertPortsAvailable,
  type E2eTarget
} from "../../../scripts/e2e-preflight";

describe("E2E preflight checks", () => {
  it("rejects shared API and web ports with actionable guidance", () => {
    const targets = [
      target("web", "http://127.0.0.1:3100"),
      target("api", "http://127.0.0.1:3100")
    ];

    expect(() => assertDistinctPorts(targets)).toThrow(/distinct localhost ports/);
  });

  it("reports occupied ports before Playwright starts web servers", async (context) => {
    const server = net.createServer();
    try {
      await listen(server);
    } catch (error) {
      // Only a genuine sandbox/network restriction is skip-worthy; anything
      // else fails loudly so the preflight contract stays covered.
      if ((error as NodeJS.ErrnoException)?.code === "EPERM") return context.skip();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address.");
    }

    await expect(
      assertPortsAvailable([target("web", `http://127.0.0.1:${address.port}`)])
    ).rejects.toThrow(/occupied ports/);

    await close(server);
  });
});

function target(name: E2eTarget["name"], url: string): E2eTarget {
  return { name, url: new URL(url) };
}

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
