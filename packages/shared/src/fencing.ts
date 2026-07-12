/**
 * Composite fencing tokens: `{instanceId}:{counter}` (§3.1).
 * Monotonic across Redis failovers via instanceId rotation.
 */

const TOKEN_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/i;

export interface ParsedFencingToken {
  instanceId: string;
  counter: number;
  raw: string;
}

export function formatFencingToken(instanceId: string, counter: number | string): string {
  return `${instanceId}:${counter}`;
}

export function parseFencingToken(token: string): ParsedFencingToken | null {
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  return {
    instanceId: m[1]!.toLowerCase(),
    counter: Number(m[2]),
    raw: token,
  };
}

export function tokensMatch(presented: string, expected: string): boolean {
  const a = parseFencingToken(presented);
  const b = parseFencingToken(expected);
  if (!a || !b) return presented === expected;
  return a.instanceId === b.instanceId && a.counter === b.counter;
}

/**
 * Reject tokens whose instanceId no longer matches the current Redis master.
 */
export function isTokenValidForInstance(
  presented: string,
  currentInstanceId: string,
): boolean {
  const parsed = parseFencingToken(presented);
  if (!parsed) return false;
  return parsed.instanceId.toLowerCase() === currentInstanceId.toLowerCase();
}
