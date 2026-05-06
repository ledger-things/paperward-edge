// src/utils/bounded-fetch.ts

export type BoundedFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
};

export type BoundedFetchResult = { ok: true; body: Response } | { ok: false; reason: string };

/**
 * Wrap fetch() with a hard timeout, a max-response-size cap, and an explicit
 * no-redirect policy. Used for the Signature-Agent public-key fetch in the
 * WBA detector to prevent SSRF amplification.
 *
 * The fetch function is dependency-injected to make this unit-testable
 * outside the Workers runtime.
 */
export async function boundedFetch(
  url: string,
  options: BoundedFetchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<BoundedFetchResult> {
  const ctrl = new AbortController();

  // Race the fetch against a timeout that fires an AbortError.
  // Using Promise.race ensures the timeout fires even if the injected
  // fetchImpl doesn't respect the abort signal (e.g. in tests).
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      ctrl.abort();
      const err = new Error("timeout");
      err.name = "AbortError";
      reject(err);
    }, options.timeoutMs);
  });

  let resp: Response;
  try {
    resp = await Promise.race([
      fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
      }),
      timeoutPromise,
    ]);
  } catch (err: unknown) {
    clearTimeout(timeoutHandle!);
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "fetch_failed" };
  }
  clearTimeout(timeoutHandle!);

  // Treat any 3xx as a redirect we won't follow.
  if (resp.status >= 300 && resp.status < 400) {
    return { ok: false, reason: "redirect_not_followed" };
  }

  // Enforce body size cap via streaming reader — works even when
  // content-length is absent (e.g. chunked transfer encoding).
  const reader = resp.body?.getReader();
  if (!reader) {
    // Body is null (e.g. HEAD response) — nothing to cap.
    return { ok: true, body: new Response(null, { status: resp.status, headers: resp.headers }) };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > options.maxBytes) {
        reader.cancel().catch(() => {});
        return { ok: false, reason: "response_too_large" };
      }
      chunks.push(value);
    }
  }

  // Reassemble buffered bytes into a new Response so callers can use .text() etc.
  const buffered = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new Response(buffered, { status: resp.status, headers: resp.headers }) };
}
