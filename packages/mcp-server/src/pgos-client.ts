/**
 * PGOS HTTP client used by Vibrato MCP tools.
 * Extracted for unit tests (M-14): mock fetch, 401/404/500 paths.
 */

export type PgosClientConfig = {
  /** Base orchestrator URL (no trailing slash). Defaults to PGOS_BASE_URL or localhost:8080. */
  baseUrl?: string;
  /** Bearer token. Defaults to PGOS_API_TOKEN. */
  apiToken?: string;
  /** Injectable fetch (tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
};

export type PgosFetch = (path: string, init?: RequestInit) => Promise<unknown>;

export function resolvePgosBaseUrl(raw?: string): string {
  return (raw ?? process.env.PGOS_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
}

export function resolvePgosApiToken(raw?: string): string {
  return raw ?? process.env.PGOS_API_TOKEN ?? '';
}

/**
 * Create a PGOS JSON API client: GET/POST `${baseUrl}/api/v1${path}`.
 * Throws Error with API error.message or `HTTP {status}` on non-2xx.
 */
export function createPgosFetch(config: PgosClientConfig = {}): PgosFetch {
  const baseUrl = resolvePgosBaseUrl(config.baseUrl);
  const apiToken = resolvePgosApiToken(config.apiToken);
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return async function pgosFetch(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (apiToken) {
      headers.Authorization = `Bearer ${apiToken}`;
    }

    const url = `${baseUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
    const res = await fetchImpl(url, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };

    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      const err = new Error(msg) as Error & { status?: number; code?: string };
      err.status = res.status;
      if (body?.error?.code) err.code = body.error.code;
      throw err;
    }
    return body;
  };
}
