import { mkdtempSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { address } from "./addressing.js";
import { FileLineJournal, FileObjectStore } from "./store.js";
import { buildRequest } from "./wire.js";
import { createLoomHttp2Server, LoomHttp2Client } from "./wire-transport.js";
import type { Cid } from "./types.js";

const SECRET = "transport-secret";
const GENESIS = address({ kind: "line", name: "main", scope: "shared", head: "x" as Cid });

describe("Loom Wire HTTP/2 transport", () => {
  let root: string;
  let server: http2.Http2Server;
  let client: LoomHttp2Client;
  let port: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "loom-wire-"));
    const store = new FileObjectStore(root);
    const journal = new FileLineJournal(root);
    server = createLoomHttp2Server({ store, journal, secret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addressInfo = server.address() as { port: number };
    port = addressInfo.port;
    client = new LoomHttp2Client(`http://localhost:${port}`, SECRET);
  });

  afterEach(async () => {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("negotiates hello with version and methods", async () => {
    const result = (await client.request("hello", {})) as { version: number; methods: string[] };
    expect(result.version).toBe(1);
    expect(result.methods).toContain("object.put");
    expect(result.methods).toContain("line.advance");
  });

  it("round-trips a raw object via object.put/object.get", async () => {
    const bytes = new TextEncoder().encode("hello wire");
    const put = (await client.request("object.put", { bytes: Buffer.from(bytes).toString("base64") })) as {
      cid: string;
    };
    const get = (await client.request("object.get", { cid: put.cid })) as { bytes: string };
    expect(Uint8Array.from(Buffer.from(get.bytes, "base64"))).toEqual(bytes);
  });

  it("returns an error for a missing object", async () => {
    await expect(
      client.request("object.get", { cid: "loom:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" })
    ).rejects.toThrow(/not found/);
  });

  it("reads and advances a Line across the wire", async () => {
    const head1 = address({ v: 1 });
    const read = await client.request("line.read", { name: "main" });
    expect(read).toBeNull();

    const advance = (await client.request("line.advance", {
      name: "main",
      scope: "shared",
      expectedHead: GENESIS,
      expectedSequence: 0,
      newHead: head1
    })) as { ok: boolean; entry: { head: string; sequence: number } };
    expect(advance.ok).toBe(true);
    expect(advance.entry).toMatchObject({ head: head1, sequence: 0 });

    const readAfter = (await client.request("line.read", { name: "main" })) as { head: string };
    expect(readAfter.head).toBe(head1);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { request } = buildRequest("hello", {}, SECRET);
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const session = http2.connect(`http://localhost:${port}`);
      const req = session.request({ ":method": "POST", ":path": "/rpc", "content-type": "application/json" });
      req.setEncoding("utf8");
      let body = "";
      req.on("response", (headers) => {
        const status = headers[":status"] ?? 0;
        req.on("data", (c: string) => (body += c));
        req.on("end", () => {
          resolve({ status, body });
          session.close();
        });
      });
      req.on("error", reject);
      req.end(JSON.stringify(request));
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain("unauthorized");
  });

  it("rejects a malformed body with 400", async () => {
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const session = http2.connect(`http://localhost:${port}`);
      const req = session.request({ ":method": "POST", ":path": "/rpc", "content-type": "application/json" });
      req.on("response", (headers) => {
        resolve({ status: headers[":status"] ?? 0 });
        req.resume();
        req.on("end", () => session.close());
      });
      req.on("error", reject);
      req.end("not json");
    });
    expect(response.status).toBe(400);
  });
});
