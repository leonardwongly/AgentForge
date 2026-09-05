/**
 * Build internal links from opaque identifiers without allowing an identifier
 * to change the route structure. Keep the suffixes fixed at each call site.
 */
export function recordHref(recordId: string): string {
  return `/records/${encodeOpaqueSegment(recordId)}`;
}

export function repositoryHref(repositoryId: string, suffix: "policy" | "policy-preview"): string {
  return `/repositories/${encodeOpaqueSegment(repositoryId)}/${suffix}`;
}

/**
 * `encodeURIComponent` throws for a lone UTF-16 surrogate. Identifiers are
 * opaque data received from an API, so a malformed string must not crash a
 * server-rendered page or turn a data problem into a 500 response.
 */
export function encodeOpaqueSegment(value: string): string {
  return encodeURIComponent(toWellFormed(value));
}

function toWellFormed(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value.charAt(index);
    }
  }
  return result;
}
