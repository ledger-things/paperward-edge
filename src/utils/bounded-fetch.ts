// src/utils/bounded-fetch.ts

export type BoundedFetchOptions = {
  timeoutMs: number;
  maxBytes: number;
};

export type BoundedFetchResult =
  | { ok: true; body: Response }
  | { ok: false; reason: string };

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

  const contentLength = resp.headers.get("content-length");
  if (contentLength !== null) {
    const len = Number(contentLength);
    if (Number.isFinite(len) && len > options.maxBytes) {
      return { ok: false, reason: "response_too_large" };
    }
  }

  return { ok: true, body: resp };
}
