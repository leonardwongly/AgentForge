const DEFAULT_MAX_JSON_RESPONSE_BYTES = 2_000_000;

/**
 * Read a JSON response with an explicit byte ceiling. A valid HTTP status is
 * not enough to trust an upstream response: a broken or compromised API must
 * not be able to make a server action or page allocate an unbounded body.
 */
export async function readBoundedJson<T>(
  response: Response,
  maxBytes = DEFAULT_MAX_JSON_RESPONSE_BYTES
): Promise<T> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredLength = Number(contentLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      throw new Error("API response exceeded the dashboard response size limit.");
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("API response exceeded the dashboard response size limit.");
    }
    return JSON.parse(text) as T;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("dashboard response too large");
        throw new Error("API response exceeded the dashboard response size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
