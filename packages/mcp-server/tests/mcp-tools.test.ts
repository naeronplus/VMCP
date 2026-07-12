/**
 * M-14: Expand MCP server tests
 *  7.4.1 Tool registration: 6 tools
 *  7.4.2 pgosFetch 401/404/500
 *  7.4.3 create_job input schema shape
 *  7.4.4 Mock fetch
 * DoD: ≥10 MCP tests
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createVibratoMcpServer,
  createPgosFetch,
  resolvePgosBaseUrl,
  resolvePgosApiToken,
  VIBRATO_TOOL_NAMES,
  VIBRATO_TOOL_COUNT,
  createJobInputSchema,
  createJobInputObjectSchema,
} from '../src/server.js';
import { z } from 'zod';

const SAMPLE_UUID = '11111111-1111-4111-8111-111111111111';
const SAMPLE_JOB = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// Mock fetch helpers (7.4.4)
// ---------------------------------------------------------------------------

type MockHandler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createMockFetch(handler: MockHandler): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  };
  return fn as typeof fetch;
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe('Vibrato MCP config', () => {
  const prevBase = process.env.PGOS_BASE_URL;
  const prevToken = process.env.PGOS_API_TOKEN;

  afterEach(() => {
    if (prevBase === undefined) delete process.env.PGOS_BASE_URL;
    else process.env.PGOS_BASE_URL = prevBase;
    if (prevToken === undefined) delete process.env.PGOS_API_TOKEN;
    else process.env.PGOS_API_TOKEN = prevToken;
  });

  it('defaults PGOS_BASE_URL to http://localhost:8080 and strips trailing slash', () => {
    delete process.env.PGOS_BASE_URL;
    assert.equal(resolvePgosBaseUrl(), 'http://localhost:8080');
    assert.equal(resolvePgosBaseUrl('http://example.com/'), 'http://example.com');
    assert.equal(resolvePgosBaseUrl('http://example.com'), 'http://example.com');
  });

  it('defaults PGOS_API_TOKEN to empty string', () => {
    delete process.env.PGOS_API_TOKEN;
    assert.equal(resolvePgosApiToken(), '');
    assert.equal(resolvePgosApiToken('secret'), 'secret');
  });
});

// ---------------------------------------------------------------------------
// 7.4.1 Tool registration: 6 tools
// ---------------------------------------------------------------------------

describe('MCP tool registration (M-14 / 7.4.1)', () => {
  it(`exports exactly ${VIBRATO_TOOL_COUNT} canonical tool names`, () => {
    assert.equal(VIBRATO_TOOL_COUNT, 6);
    assert.equal(VIBRATO_TOOL_NAMES.length, 6);
    assert.deepEqual([...VIBRATO_TOOL_NAMES], [
      'list_projects',
      'list_jobs',
      'get_job',
      'create_job',
      'list_locks',
      'get_job_status',
    ]);
  });

  it('registers exactly 6 tools on McpServer (listTools via in-memory transport)', async () => {
    const server = createVibratoMcpServer({
      fetchImpl: createMockFetch(() => jsonResponse(200, {})),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    const expected = [...VIBRATO_TOOL_NAMES].sort();

    assert.equal(listed.tools.length, 6, `expected 6 tools, got ${names.join(', ')}`);
    assert.deepEqual(names, expected);

    await client.close();
    await server.close();
  });

  it('each registered tool has a non-empty description', async () => {
    const server = createVibratoMcpServer({
      fetchImpl: createMockFetch(() => jsonResponse(200, {})),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    for (const tool of listed.tools) {
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} missing description`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} inputSchema.type`);
    }

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 7.4.3 create_job input schema shape
// ---------------------------------------------------------------------------

describe('create_job input schema (M-14 / 7.4.3)', () => {
  it('requires projectId UUID; accepts optional commitStrategy, godotVersion, preferredTier', () => {
    const shape = createJobInputSchema;
    assert.ok(shape.projectId);
    assert.ok(shape.commitStrategy);
    assert.ok(shape.godotVersion);
    assert.ok(shape.preferredTier);

    const parsed = createJobInputObjectSchema.parse({
      projectId: SAMPLE_UUID,
      commitStrategy: 'cross-machine',
      godotVersion: '4.3.1',
      preferredTier: 'A',
    });
    assert.equal(parsed.projectId, SAMPLE_UUID);
    assert.equal(parsed.commitStrategy, 'cross-machine');
    assert.equal(parsed.godotVersion, '4.3.1');
    assert.equal(parsed.preferredTier, 'A');
  });

  it('rejects missing projectId and invalid UUID / enums', () => {
    assert.throws(() => createJobInputObjectSchema.parse({}), /Required|invalid/i);
    assert.throws(
      () => createJobInputObjectSchema.parse({ projectId: 'not-a-uuid' }),
      /uuid|invalid/i,
    );
    assert.throws(
      () =>
        createJobInputObjectSchema.parse({
          projectId: SAMPLE_UUID,
          commitStrategy: 'remote',
        }),
      /invalid|enum/i,
    );
    assert.throws(
      () =>
        createJobInputObjectSchema.parse({
          projectId: SAMPLE_UUID,
          preferredTier: 'C',
        }),
      /invalid|enum/i,
    );
  });

  it('create_job tool advertises required projectId in MCP inputSchema', async () => {
    const server = createVibratoMcpServer({
      fetchImpl: createMockFetch(() => jsonResponse(200, {})),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const createJob = listed.tools.find((t) => t.name === 'create_job');
    assert.ok(createJob, 'create_job tool registered');

    const schema = createJob.inputSchema as {
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties?.projectId, 'projectId property');
    assert.ok(
      schema.required?.includes('projectId'),
      `projectId must be required, required=${JSON.stringify(schema.required)}`,
    );
    // Optional fields present as properties
    assert.ok(schema.properties?.commitStrategy);
    assert.ok(schema.properties?.godotVersion);
    assert.ok(schema.properties?.preferredTier);

    await client.close();
    await server.close();
  });

  it('list_jobs and get_job schemas expose expected properties', async () => {
    const server = createVibratoMcpServer({
      fetchImpl: createMockFetch(() => jsonResponse(200, {})),
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const listJobs = listed.tools.find((t) => t.name === 'list_jobs');
    const getJob = listed.tools.find((t) => t.name === 'get_job');
    assert.ok(listJobs && getJob);

    const listProps = (listJobs.inputSchema as { properties?: Record<string, unknown> }).properties;
    assert.ok(listProps?.projectId);

    const getRequired = (getJob.inputSchema as { required?: string[] }).required;
    assert.ok(getRequired?.includes('jobId'));

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 7.4.2 pgosFetch 401 / 404 / 500 + 7.4.4 mock fetch
// ---------------------------------------------------------------------------

describe('pgosFetch HTTP error paths (M-14 / 7.4.2, 7.4.4)', () => {
  it('throws with API error.message on HTTP 401', async () => {
    const pgosFetch = createPgosFetch({
      baseUrl: 'http://pgos.test',
      apiToken: 'bad-token',
      fetchImpl: createMockFetch((url) => {
        assert.match(url, /\/api\/v1\/projects$/);
        return jsonResponse(401, {
          error: { code: 'E015', message: 'Token revoked or unauthorized' },
        });
      }),
    });

    await assert.rejects(() => pgosFetch('/projects'), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Token revoked|unauthorized/i);
      assert.equal((err as Error & { status?: number }).status, 401);
      return true;
    });
  });

  it('throws with API error.message on HTTP 404', async () => {
    const pgosFetch = createPgosFetch({
      baseUrl: 'http://pgos.test',
      fetchImpl: createMockFetch(() =>
        jsonResponse(404, {
          error: { code: 'E014', message: 'Job not found' },
        }),
      ),
    });

    await assert.rejects(() => pgosFetch(`/jobs/${SAMPLE_JOB}`), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'Job not found');
      assert.equal((err as Error & { status?: number }).status, 404);
      return true;
    });
  });

  it('throws with HTTP 500 fallback message when body has no error.message', async () => {
    const pgosFetch = createPgosFetch({
      baseUrl: 'http://pgos.test',
      fetchImpl: createMockFetch(() => jsonResponse(500, { oops: true })),
    });

    await assert.rejects(() => pgosFetch('/locks'), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'HTTP 500');
      assert.equal((err as Error & { status?: number }).status, 500);
      return true;
    });
  });

  it('throws HTTP 500 with server message when present', async () => {
    const pgosFetch = createPgosFetch({
      baseUrl: 'http://pgos.test',
      fetchImpl: createMockFetch(() =>
        jsonResponse(500, { error: { message: 'internal orchestrator fault' } }),
      ),
    });

    await assert.rejects(() => pgosFetch('/projects'), /internal orchestrator fault/);
  });

  it('sends Authorization bearer when apiToken configured (mock fetch)', async () => {
    let sawAuth: string | null = null;
    let sawUrl = '';
    const pgosFetch = createPgosFetch({
      baseUrl: 'http://pgos.test/',
      apiToken: 'test-jwt',
      fetchImpl: createMockFetch((url, init) => {
        sawUrl = url;
        const h = init?.headers as Record<string, string>;
        sawAuth = h?.Authorization ?? null;
        return jsonResponse(200, { projects: [{ id: SAMPLE_UUID }] });
      }),
    });

    const body = (await pgosFetch('/projects')) as { projects: unknown[] };
    assert.equal(sawUrl, 'http://pgos.test/api/v1/projects');
    assert.equal(sawAuth, 'Bearer test-jwt');
    assert.equal(body.projects.length, 1);
  });

  it('omits Authorization when token is empty', async () => {
    let headers: Record<string, string> = {};
    const pgosFetch = createPgosFetch({
      baseUrl: 'http://pgos.test',
      apiToken: '',
      fetchImpl: createMockFetch((_url, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        return jsonResponse(200, { ok: true });
      }),
    });

    await pgosFetch('/locks');
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('returns parsed JSON body on 2xx', async () => {
    const pgosFetch = createPgosFetch({
      baseUrl: 'http://pgos.test',
      fetchImpl: createMockFetch(() => jsonResponse(200, { job: { id: SAMPLE_JOB, status: 'QUEUED' } })),
    });
    const data = (await pgosFetch(`/jobs/${SAMPLE_JOB}`)) as { job: { status: string } };
    assert.equal(data.job.status, 'QUEUED');
  });
});

// ---------------------------------------------------------------------------
// Tool handlers with mock fetch (end-to-end through MCP callTool)
// ---------------------------------------------------------------------------

describe('MCP tool handlers with mock fetch (M-14 / 7.4.4)', () => {
  async function withClient(
    fetchImpl: typeof fetch,
    fn: (client: Client) => Promise<void>,
  ): Promise<void> {
    const server = createVibratoMcpServer({ fetchImpl, apiToken: 'tok' });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('list_projects returns projects JSON via mock fetch', async () => {
    await withClient(
      createMockFetch((url) => {
        assert.match(url, /\/api\/v1\/projects$/);
        return jsonResponse(200, { projects: [{ id: SAMPLE_UUID, name: 'demo' }] });
      }),
      async (client) => {
        const result = await client.callTool({ name: 'list_projects', arguments: {} });
        assert.equal(result.isError, undefined);
        const text = (result.content as { type: string; text: string }[])[0]?.text;
        assert.match(text, /demo/);
        assert.match(text, new RegExp(SAMPLE_UUID));
      },
    );
  });

  it('create_job POSTs body to /jobs and returns response', async () => {
    let method = '';
    let postBody = '';
    await withClient(
      createMockFetch((url, init) => {
        if (url.endsWith('/api/v1/jobs') && init?.method === 'POST') {
          method = init.method;
          postBody = String(init.body ?? '');
          return jsonResponse(201, { job: { id: SAMPLE_JOB, status: 'QUEUED' } });
        }
        return jsonResponse(404, { error: { message: 'unexpected ' + url } });
      }),
      async (client) => {
        const result = await client.callTool({
          name: 'create_job',
          arguments: {
            projectId: SAMPLE_UUID,
            commitStrategy: 'same-machine',
            godotVersion: '4.3.1',
            preferredTier: 'B',
          },
        });
        assert.equal(method, 'POST');
        const parsed = JSON.parse(postBody) as Record<string, string>;
        assert.equal(parsed.projectId, SAMPLE_UUID);
        assert.equal(parsed.commitStrategy, 'same-machine');
        assert.equal(parsed.godotVersion, '4.3.1');
        assert.equal(parsed.preferredTier, 'B');
        const text = (result.content as { type: string; text: string }[])[0]?.text;
        assert.match(text, /QUEUED/);
      },
    );
  });

  it('get_job surfaces pgosFetch 404 as tool error', async () => {
    await withClient(
      createMockFetch(() =>
        jsonResponse(404, { error: { message: 'Job not found', code: 'NOT_FOUND' } }),
      ),
      async (client) => {
        const result = await client.callTool({
          name: 'get_job',
          arguments: { jobId: SAMPLE_JOB },
        });
        // MCP SDK marks handler throws as isError
        assert.equal(result.isError, true);
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
        assert.match(text, /Job not found|HTTP 404/i);
      },
    );
  });

  it('list_jobs passes projectId query string', async () => {
    let hit = '';
    await withClient(
      createMockFetch((url) => {
        hit = url;
        return jsonResponse(200, { jobs: [] });
      }),
      async (client) => {
        await client.callTool({
          name: 'list_jobs',
          arguments: { projectId: SAMPLE_UUID },
        });
        assert.match(hit, new RegExp(`/api/v1/jobs\\?projectId=${SAMPLE_UUID}`));
      },
    );
  });

  it('get_job_status returns status envelope from job payload', async () => {
    await withClient(
      createMockFetch(() =>
        jsonResponse(200, { job: { id: SAMPLE_JOB, status: 'STAGING' } }),
      ),
      async (client) => {
        const result = await client.callTool({
          name: 'get_job_status',
          arguments: { jobId: SAMPLE_JOB },
        });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
        const payload = JSON.parse(text) as { jobId: string; status: string };
        assert.equal(payload.jobId, SAMPLE_JOB);
        assert.equal(payload.status, 'STAGING');
      },
    );
  });
});

// Compile-time: schemas are Zod types usable with z.object
describe('schema exports', () => {
  it('createJobInputObjectSchema is a Zod object', () => {
    assert.ok(createJobInputObjectSchema instanceof z.ZodObject);
  });
});
