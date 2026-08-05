/**
 * @agentforge/loom-core — Loom Wire v1 HTTP/2 transport (Phase 0, spec §23 #6).
 *
 * A minimal HTTP/2 (h2c) server and client for the Loom Wire protocol. The
 * server authenticates each request via the `Authorization: Loom <hmac>`
 * header, dispatches to the object store and Line journal, and returns a
 * versioned JSON envelope. This is the reference transport for the frozen wire
 * binding; it uses Node's built-in `http2` and needs no external dependencies.
 */

import http2 from "node:http2";

import type { FileLineJournal, FileObjectStore } from "./store.js";
import {
  buildRequest,
  negotiate,
  validateWireMessage,
  verifyRequest,
  WIRE_CONTENT_TYPE,
  type WireRequest
} from "./wire.js";
import type { Cid, LineScope } from "./types.js";

export interface WireServerDeps {
  readonly store: FileObjectStore;
  readonly journal: FileLineJournal;
  readonly secret: string;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function errorBody(id: string, code: string, message: string): string {
  return JSON.stringify({ v: 1, id, ok: false, error: { code, message } });
}

async function dispatch(deps: WireServerDeps, request: WireRequest): Promise<unknown> {
  const params = request.params as Record<string, string | number | undefined>;
  switch (request.method) {
    case "hello":
      return negotiate();
    case "object.put": {
      const bytes = fromBase64(String(params.bytes ?? ""));
      const cid = deps.store.putRaw(bytes);
      return { cid };
    }
    case "object.get": {
      const cid = String(params.cid ?? "");
      const bytes = deps.store.getRaw(cid as Cid);
      if (bytes === undefined) {
        throw new Error(`object not found: ${cid}`);
      }
      return { bytes: toBase64(bytes) };
    }
    case "line.read": {
      const name = String(params.name ?? "");
      return deps.journal.read(name) ?? null;
    }
    case "line.advance": {
      return deps.journal.advance({
        name: String(params.name ?? ""),
        scope: String(params.scope ?? "shared") as LineScope,
        expectedHead: String(params.expectedHead ?? "") as Cid,
        expectedSequence: Number(params.expectedSequence ?? 0),
        newHead: String(params.newHead ?? "") as Cid,
        idempotencyKey: params.idempotencyKey === undefined ? undefined : String(params.idempotencyKey)
      });
    }
    default:
      throw new Error(`unsupported method ${request.method}`);
  }
}

/** Create an HTTP/2 (h2c) server that serves the Loom Wire RPC endpoint. */
export function createLoomHttp2Server(deps: WireServerDeps): http2.Http2Server {
  const server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    if (headers[":method"] !== "POST" || headers[":path"] !== "/rpc") {
      stream.respond({ ":status": 404, "content-type": "application/json" });
      stream.end(errorBody("", "not_found", "only POST /rpc is supported"));
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const auth = typeof headers.authorization === "string" ? headers.authorization : undefined;
        const [status, payload] = await handle(deps, body, auth);
        stream.respond({ ":status": status, "content-type": WIRE_CONTENT_TYPE });
        stream.end(payload);
      })();
    });
  });
  return server;
}

async function handle(deps: WireServerDeps, body: string, auth: string | undefined): Promise<[number, string]> {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return [400, errorBody("", "bad_request", "invalid JSON body")];
  }
  const validation = validateWireMessage(message);
  if (validation !== undefined) {
    return [400, errorBody("", "bad_request", validation)];
  }
  const request = message as WireRequest;
  const signature = auth?.startsWith("Loom ") ? auth.slice("Loom ".length) : undefined;
  const authError = verifyRequest(request, signature, deps.secret);
  if (authError !== undefined) {
    return [401, errorBody(request.id, "unauthorized", authError)];
  }
  try {
    const result = await dispatch(deps, request);
    return [200, JSON.stringify({ v: 1, id: request.id, ok: true, result })];
  } catch (error) {
    return [500, errorBody(request.id, "internal_error", (error as Error).message)];
  }
}

/** A minimal Loom Wire HTTP/2 client. */
export class LoomHttp2Client {
  private readonly session: http2.ClientHttp2Session;

  constructor(url: string, private readonly secret: string) {
    this.session = http2.connect(url);
  }

  request(method: WireRequest["method"], params: Record<string, unknown>): Promise<unknown> {
    const { request, signature } = buildRequest(method, params, this.secret);
    return new Promise((resolve, reject) => {
      const req = this.session.request({
        ":method": "POST",
        ":path": "/rpc",
        "content-type": WIRE_CONTENT_TYPE,
        authorization: `Loom ${signature}`
      });
      req.setEncoding("utf8");
      let body = "";
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const message = JSON.parse(body) as { ok: boolean; result?: unknown; error?: { message?: string } };
          if (message.ok) {
            resolve(message.result);
          } else {
            reject(new Error(message.error?.message ?? "wire error"));
          }
        } catch (error) {
          reject(error);
        }
      });
      req.on("error", reject);
      req.end(JSON.stringify(request));
    });
  }

  close(): void {
    this.session.close();
  }
}
