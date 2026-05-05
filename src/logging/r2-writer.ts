// src/logging/r2-writer.ts
//
// Writes a single LogEntry to R2 as an ND-JSON object using a prefix-sharded
// key (spec §4.6). Prefix-first ordering — `requests/{ulid_prefix}/dt=...` —
// spreads writes across 4096 R2 prefix shards so a viral tenant cannot
// bottleneck on the per-prefix PUT rate cap.

import type { LogEntry } from "@/logging/types";

export function logKey(entry: LogEntry): string {
  // Lowercase only hex characters (0-9 are unchanged; A-F → a-f) so that
  // `01H8` stays `01H8` (H is not hex) while `ABCD` becomes `abcd`.
  const prefix = entry.id.slice(0, 4).replace(/[A-F]/g, (c) => c.toLowerCase());
  const date = entry.ts.slice(0, 10); // YYYY-MM-DD
  return `requests/${prefix}/dt=${date}/tenant=${entry.tenant_id}/${entry.id}.ndjson`;
}

export async function writeLogToR2(r2: R2Bucket, entry: LogEntry): Promise<boolean> {
  const body = JSON.stringify(entry) + "\n";
  try {
    await r2.put(logKey(entry), body, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    return true;
  } catch (err) {
    console.error(JSON.stringify({ at: "writeLogToR2", err: String(err), entry_id: entry.id }));
    return false;
  }
}
