/**
 * @agentforge/loom-core — Loom Wire v1 HTTP/2 transport (Phase 0, spec §23 #6).
 *
 * A minimal HTTP/2 server and client for the Loom Wire protocol. The
 * server authenticates each request via the `Authorization: Loom <hmac>`
 * header, dispatches to the object store and Line journal, and returns a
 * versioned JSON envelope. This is the reference transport for the frozen wire
 * binding; it uses Node's built-in `http2` and needs no external dependencies.
 */

import http2 from "node:http2";

export interface LoomTlsOptions {
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly ca?: string | Buffer | (string | Buffer)[] | undefined;
  readonly requestCert?: boolean | undefined;
  readonly rejectUnauthorized?: boolean | undefined;
}

export interface LoomTlsClientOptions {
  readonly key?: string | Buffer;
  readonly cert?: string | Buffer;
  readonly ca?: string | Buffer | (string | Buffer)[] | undefined;
  readonly rejectUnauthorized?: boolean | undefined;
}

export interface LoomWireServerOptions {
  /** TLS/mTLS credentials. Required unless `allowInsecure` is explicitly set. */
  readonly tls?: LoomTlsOptions | undefined;
  /** Test-only/local-loopback escape hatch; never enable on a shared listener. */
  readonly allowInsecure?: boolean | undefined;
}

import type { FileLineJournal, FileObjectStore } from "./store.js";
import {
  buildRequest,
  MAX_WIRE_BODY_BYTES,
  MAX_WIRE_OBJECT_BYTES,
  NonceReplayGuard,
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
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("object payload is not valid base64");
  }
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
      const encoded = String(params.bytes ?? "");
      if (encoded.length > Math.ceil((MAX_WIRE_OBJECT_BYTES * 4) / 3) + 16) {
        throw new Error("object payload exceeds size limit");
      }
      const bytes = fromBase64(encoded);
      if (bytes.length > MAX_WIRE_OBJECT_BYTES) {
        throw new Error("object payload exceeds size limit");
      }
      const cid = deps.store.putRaw(bytes);
      return { cid };
    }
    case "object.get": {
      const cid = String(params.cid ?? "");
      const bytes = deps.store.getRaw(cid as Cid);
      if (bytes === undefined) {
        throw new Error("object not found");
      }
      if (bytes.length > MAX_WIRE_OBJECT_BYTES) {
        throw new Error("object exceeds transport size limit");
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
        idempotencyKey:
          params.idempotencyKey === undefined ? undefined : String(params.idempotencyKey)
      });
    }
    default:
      throw new Error(`unsupported method ${request.method}`);
  }
}

/** Create an HTTP/2 server that serves Loom Wire; TLS is required by default. */
export function createLoomHttp2Server(
  deps: WireServerDeps,
  options: LoomWireServerOptions = {}
): http2.Http2Server {
  if (!options.tls && !options.allowInsecure) {
    throw new Error(
      "Loom Wire requires TLS/mTLS; set allowInsecure only for local loopback tests."
    );
  }
  const server = options.tls
    ? http2.createSecureServer({
        key: options.tls.key,
        cert: options.tls.cert,
        requestCert: options.tls.requestCert,
        rejectUnauthorized: options.tls.rejectUnauthorized,
        ...(options.tls.ca === undefined
          ? {}
          : {
              ca: Array.isArray(options.tls.ca) ? Array.from(options.tls.ca) : options.tls.ca
            })
      })
    : http2.createServer();
  const replayGuard = new NonceReplayGuard();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
    if (headers[":method"] !== "POST" || headers[":path"] !== "/rpc") {
      stream.respond({ ":status": 404, "content-type": "application/json" });
      stream.end(errorBody("", "not_found", "only POST /rpc is supported"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_WIRE_BODY_BYTES) chunks.push(chunk);
      else oversized = true;
    });
    stream.on("end", () => {
      void (async () => {
        if (oversized) {
          stream.respond({ ":status": 413, "content-type": WIRE_CONTENT_TYPE });
          stream.end(errorBody("", "body_too_large", "wire request exceeds size limit"));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const auth = typeof headers.authorization === "string" ? headers.authorization : undefined;
        const [status, payload] = await handle(deps, body, auth, replayGuard);
        stream.respond({ ":status": status, "content-type": WIRE_CONTENT_TYPE });
        stream.end(payload);
      })();
    });
  });
  return server;
}

async function handle(
  deps: WireServerDeps,
  body: string,
  auth: string | undefined,
  replayGuard?: NonceReplayGuard
): Promise<[number, string]> {
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
  const authError = verifyRequest(request, signature, deps.secret, Date.now(), replayGuard);
  if (authError !== undefined) {
    return [401, errorBody(request.id, "unauthorized", authError)];
  }
  try {
    const result = await dispatch(deps, request);
    return [200, JSON.stringify({ v: 1, id: request.id, ok: true, result })];
  } catch {
    // Keep filesystem paths, CIDs, and parser details out of the remote error
    // surface. Operators can correlate the request id with server-side logs.
    return [500, errorBody(request.id, "internal_error", "wire request failed")];
  }
}

/** A minimal Loom Wire HTTP/2 client. */
export class LoomHttp2Client {
  private readonly session: http2.ClientHttp2Session;

  constructor(
    url: string,
    private readonly secret: string,
    tls?: LoomTlsClientOptions
  ) {
    if (tls === undefined) {
      this.session = http2.connect(url);
    } else {
      this.session = http2.connect(url, {
        key: tls.key,
        cert: tls.cert,
        rejectUnauthorized: tls.rejectUnauthorized,
        ...(tls.ca === undefined ? {} : { ca: Array.isArray(tls.ca) ? Array.from(tls.ca) : tls.ca })
      });
    }
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
      let responseSize = 0;
      req.on("data", (chunk: string) => {
        responseSize += Buffer.byteLength(chunk);
        if (responseSize > MAX_WIRE_BODY_BYTES) {
          req.close(http2.constants.NGHTTP2_CANCEL);
          reject(new Error("wire response exceeds size limit"));
          return;
        }
        body += chunk;
      });
      req.on("end", () => {
        try {
          const message = JSON.parse(body) as {
            ok: boolean;
            result?: unknown;
            error?: { message?: string };
          };
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
