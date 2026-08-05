# Loom Wire v1 — HTTP/2 Protocol

> Status: frozen for the Phase 0 reference transport (implemented in
> `packages/loom-core/src/wire.ts` and `wire-transport.ts`).
> Normative changes require a version bump and the decision-register process.

## 1. Transport

- HTTP/2. Cleartext (`h2c`) for local/loopback; TLS (`h2`) for remote nodes.
- Single RPC endpoint: `POST /rpc`.
- Request and response bodies are UTF-8 JSON with content type
  `application/vnd.loom.wire+json`.

## 2. Envelope

Every message carries an explicit schema version `v: 1`. Unknown versions and
unknown fields are rejected.

Request:

```json
{ "v": 1, "id": "<uuid>", "method": "<method>", "params": { ... },
  "nonce": "<uuid>", "timestamp": 1720000000000 }
```

Response:

```json
{ "v": 1, "id": "<echo>", "ok": true, "result": { ... } }
```

Error:

```json
{ "v": 1, "id": "<echo>", "ok": false, "error": { "code": "...", "message": "..." } }
```

## 3. Methods

| Method | Params | Result |
|---|---|---|
| `hello` | — | `{ version, server, methods }` (negotiation) |
| `object.put` | `bytes` (base64) | `{ cid }` |
| `object.get` | `cid` | `{ bytes }` (base64) |
| `line.read` | `name` | journal entry or `null` |
| `line.advance` | `name, scope, expectedHead, expectedSequence, newHead, idempotencyKey?` | CAS outcome |

## 4. Authentication

Each request is signed with a shared secret using HMAC-SHA256 over a canonical,
domain-separated representation of the request:

```text
loom-wire-v1|{"v":1,"id":...,"method":...,"params":...,"nonce":...,"timestamp":...}
```

The signature is carried in the `Authorization` header:

```text
Authorization: Loom <base64(hmac-sha256(secret, canonical))>
```

The server rejects requests with a missing/invalid signature and requests whose
`timestamp` is outside the 30-second replay window.

## 5. Negotiation

`hello` returns the wire version and the supported method set so a client can
fail fast against an incompatible server.

## 6. Errors

- `400 bad_request` — malformed body or envelope.
- `401 unauthorized` — missing/invalid signature or stale timestamp.
- `404 not_found` — non-`/rpc` path.
- `500 internal_error` — dispatch failure (e.g. missing object, CAS conflict).
