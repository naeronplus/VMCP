#!/usr/bin/env node
/**
 * Vibrato MCP server — stdio transport entrypoint (proxies PGOS REST API).
 * Library surface for tests: ./server.js, ./pgos-client.js, ./tool-schemas.js
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createVibratoMcpServer } from './server.js';

export {
  createVibratoMcpServer,
  createPgosFetch,
  resolvePgosBaseUrl,
  resolvePgosApiToken,
  VIBRATO_TOOL_NAMES,
  VIBRATO_TOOL_COUNT,
  createJobInputSchema,
  createJobInputObjectSchema,
} from './server.js';

async function main(): Promise<void> {
  const server = createVibratoMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Vibrato MCP server connected (stdio)');
}

function isExecutedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    return resolve(self) === resolve(entry);
  } catch {
    return false;
  }
}

if (isExecutedAsMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
