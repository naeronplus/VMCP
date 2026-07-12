#!/usr/bin/env node
/**
 * Vibrato MCP server — stdio transport proxying PGOS REST API.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PGOS_BASE_URL = (process.env.PGOS_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const PGOS_API_TOKEN = process.env.PGOS_API_TOKEN ?? '';

async function pgosFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (PGOS_API_TOKEN) {
    headers.Authorization = `Bearer ${PGOS_API_TOKEN}`;
  }
  const res = await fetch(`${PGOS_BASE_URL}/api/v1${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

const server = new McpServer({
  name: 'Vibrato',
  version: '1.0.0',
});

server.tool(
  'list_projects',
  'List PGOS projects',
  {},
  async () => {
    const data = (await pgosFetch('/projects')) as { projects: unknown[] };
    return {
      content: [{ type: 'text', text: JSON.stringify(data.projects, null, 2) }],
    };
  },
);

server.tool(
  'list_jobs',
  'List generation jobs, optionally filtered by project',
  { projectId: z.string().uuid().optional() },
  async ({ projectId }) => {
    const q = projectId ? `?projectId=${projectId}` : '';
    const data = await pgosFetch(`/jobs${q}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'get_job',
  'Get a single job by ID',
  { jobId: z.string().uuid() },
  async ({ jobId }) => {
    const data = await pgosFetch(`/jobs/${jobId}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'create_job',
  'Enqueue a generation job for a project',
  {
    projectId: z.string().uuid(),
    commitStrategy: z.enum(['same-machine', 'cross-machine']).optional(),
    godotVersion: z.string().optional(),
    preferredTier: z.enum(['A', 'B']).optional(),
  },
  async (args) => {
    const data = await pgosFetch('/jobs', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'list_locks',
  'List active generation locks',
  {},
  async () => {
    const data = await pgosFetch('/locks');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'get_job_status',
  'Alias for get_job — returns job status payload',
  { jobId: z.string().uuid() },
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Vibrato MCP server connected (stdio)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});