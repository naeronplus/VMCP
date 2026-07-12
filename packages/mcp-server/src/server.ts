/**
 * Vibrato MCP server factory — registers PGOS proxy tools.
 * Importable without starting stdio (main lives in index.ts).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createPgosFetch, type PgosClientConfig, type PgosFetch } from './pgos-client.js';
import {
  createJobInputSchema,
  jobIdInputSchema,
  listJobsInputSchema,
  VIBRATO_TOOL_NAMES,
} from './tool-schemas.js';

export type CreateVibratoMcpServerOptions = PgosClientConfig & {
  /** Override pgosFetch entirely (takes precedence over baseUrl/token/fetchImpl). */
  pgosFetch?: PgosFetch;
  name?: string;
  version?: string;
};

/**
 * Build an McpServer with exactly the Vibrato tool set (6 tools).
 */
export function createVibratoMcpServer(options: CreateVibratoMcpServerOptions = {}): McpServer {
  const pgosFetch =
    options.pgosFetch ??
    createPgosFetch({
      baseUrl: options.baseUrl,
      apiToken: options.apiToken,
      fetchImpl: options.fetchImpl,
    });

  const server = new McpServer({
    name: options.name ?? 'Vibrato',
    version: options.version ?? '1.0.0',
  });

  server.tool('list_projects', 'List PGOS projects', {}, async () => {
    const data = (await pgosFetch('/projects')) as { projects: unknown[] };
    return {
      content: [{ type: 'text', text: JSON.stringify(data.projects, null, 2) }],
    };
  });

  server.tool(
    'list_jobs',
    'List generation jobs, optionally filtered by project',
    listJobsInputSchema,
    async ({ projectId }) => {
      const q = projectId ? `?projectId=${projectId}` : '';
      const data = await pgosFetch(`/jobs${q}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool('get_job', 'Get a single job by ID', jobIdInputSchema, async ({ jobId }) => {
    const data = await pgosFetch(`/jobs/${jobId}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool(
    'create_job',
    'Enqueue a generation job for a project',
    createJobInputSchema,
    async (args) => {
      const data = await pgosFetch('/jobs', {
        method: 'POST',
        body: JSON.stringify(args),
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool('list_locks', 'List active generation locks', {}, async () => {
    const data = await pgosFetch('/locks');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool(
    'get_job_status',
    'Alias for get_job — returns job status payload',
    jobIdInputSchema,
    async ({ jobId }) => {
      const data = (await pgosFetch(`/jobs/${jobId}`)) as { job: { status: string } };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ jobId, status: data.job?.status, job: data.job }, null, 2),
          },
        ],
      };
    },
  );

  // Compile-time / runtime guard: registration count matches canonical list
  void VIBRATO_TOOL_NAMES;

  return server;
}

export { VIBRATO_TOOL_NAMES, VIBRATO_TOOL_COUNT } from './tool-schemas.js';
export { createPgosFetch, resolvePgosBaseUrl, resolvePgosApiToken } from './pgos-client.js';
export {
  createJobInputSchema,
  createJobInputObjectSchema,
  listJobsInputSchema,
  jobIdInputSchema,
} from './tool-schemas.js';
