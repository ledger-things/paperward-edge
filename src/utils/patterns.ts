// src/utils/patterns.ts

/**
 * Match a request path against a pricing-rule path_pattern.
 * Supported forms:
 *  - "*"           → match any path
 *  - "/foo"        → exact match
 *  - "/foo/*"      → suffix wildcard; matches /foo/x and deeper, NOT /foo
 *
 * Query strings on the request path are stripped before matching.
 */
export function matchPath(pattern: string, path: string): boolean {
  const cleanPath = path.split("?")[0] ?? path;
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // keep the trailing "/"
    return cleanPath.startsWith(prefix);
  }
  return cleanPath === pattern;
}

/**
 * Match a detected agent_id against a pricing-rule agent_pattern.
 * Supported forms:
 *  - "*"                 → any agent including null
 *  - "signed:*"          → any agent_id starting with "signed:"
 *  - "signed:{operator}" → exact match
 *  - "unsigned:*"        → any agent_id starting with "unsigned:"
 *  - "unsigned:{name}"   → exact match
 *  - "human"             → exact, only if agent_id === "human"
 *  - "unknown"           → only if agent_id === null
 */
export function matchAgent(pattern: string, agentId: string | null): boolean {
  if (pattern === "*") return true;
  if (pattern === "unknown") return agentId === null;
  if (agentId === null) return false;

  if (pattern === "signed:*") return agentId.startsWith("signed:");
  if (pattern === "unsigned:*") return agentId.startsWith("unsigned:");

  return pattern === agentId;
}
