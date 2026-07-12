import type { WsJobEvent } from '@vibrato/shared';
import type { WebSocket } from 'ws';

export interface WsClientContext {
  role: string;
  /** Empty = admin/operator sees all; viewers must subscribe to project IDs. */
  projectIds: Set<string>;
}

/**
 * Pure RBAC filter for job-scoped WebSocket events (TEST-02).
 * - admin / operator: all project IDs
 * - viewer with empty projectIds: scoped events only when projectId is null (global)
 * - viewer with subscriptions: only matching projectId
 * - event without projectId (null): delivered to all connected clients (global)
 */
export function mayReceiveJobEvent(
  ctx: WsClientContext,
  projectId: string | null,
): boolean {
  if (ctx.role === 'admin' || ctx.role === 'operator') return true;
  if (!projectId) return true;
  if (ctx.projectIds.size === 0) return false;
  return ctx.projectIds.has(projectId);
}

/** Apply client `subscribe` control messages to viewer filter (TEST-02). */
export function handleWsClientMessage(
  ctx: WsClientContext,
  raw: string | Buffer | ArrayBuffer | Buffer[],
): void {
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw).toString('utf8');
    const msg = JSON.parse(text) as {
      type?: string;
      projectIds?: string[];
    };
    if (msg.type === 'subscribe' && Array.isArray(msg.projectIds)) {
      ctx.projectIds = new Set(msg.projectIds);
    }
  } catch {
    /* ignore malformed client messages */
  }
}

/**
 * Resolve project scope from a hub event payload.
 * Supports `payload.projectId` and nested `payload.job.projectId` (job.updated).
 * Missing projectId → null → broadcast to all connected clients (documented global path).
 */
export function extractProjectId(event: WsJobEvent): string | null {
  const payload = event.payload as {
    projectId?: string;
    job?: { projectId?: string };
  };
  return payload?.projectId ?? payload?.job?.projectId ?? null;
}

type TrackedSocket = WebSocket & { pgos?: WsClientContext };

/**
 * In-process WebSocket fan-out hub. Prefer {@link createWsHub} in tests so the
 * process-global singleton is not required.
 */
export class WsHub {
  private clients = new Set<TrackedSocket>();

  add(ws: WebSocket, ctx: WsClientContext): void {
    const tracked = ws as TrackedSocket;
    tracked.pgos = ctx;
    this.clients.add(tracked);
    ws.on('close', () => this.clients.delete(tracked));
    ws.on('message', (raw) => {
      if (tracked.pgos) handleWsClientMessage(tracked.pgos, raw);
    });
  }

  broadcast(event: WsJobEvent): void {
    const data = JSON.stringify(event);
    const projectId = extractProjectId(event);
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue;
      if (!this.mayReceive(ws, projectId)) continue;
      ws.send(data);
    }
  }

  private mayReceive(ws: TrackedSocket, projectId: string | null): boolean {
    const ctx = ws.pgos;
    if (!ctx) return true;
    return mayReceiveJobEvent(ctx, projectId);
  }

  size(): number {
    return this.clients.size;
  }
}

let hub: WsHub | null = null;

/** Factory for isolated hubs (unit tests / multi-instance). */
export function createWsHub(): WsHub {
  return new WsHub();
}

export function getWsHub(): WsHub | null {
  return hub;
}

export function initWsHub(): WsHub {
  hub = createWsHub();
  return hub;
}
