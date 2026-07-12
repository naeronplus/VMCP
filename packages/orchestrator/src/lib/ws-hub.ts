import type { WsJobEvent } from '@vibrato/shared';
import type { WebSocket } from 'ws';

export interface WsClientContext {
  role: string;
  /** Empty = admin/operator sees all; viewers must subscribe to project IDs. */
  projectIds: Set<string>;
}

type TrackedSocket = WebSocket & { pgos?: WsClientContext };

class WsHub {
  private clients = new Set<TrackedSocket>();

  add(ws: WebSocket, ctx: WsClientContext): void {
    const tracked = ws as TrackedSocket;
    tracked.pgos = ctx;
    this.clients.add(tracked);
    ws.on('close', () => this.clients.delete(tracked));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          type?: string;
          projectIds?: string[];
        };
        if (msg.type === 'subscribe' && Array.isArray(msg.projectIds)) {
          tracked.pgos!.projectIds = new Set(msg.projectIds);
        }
      } catch {
        /* ignore malformed client messages */
      }
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
    if (ctx.role === 'admin' || ctx.role === 'operator') return true;
    if (!projectId) return true;
    if (ctx.projectIds.size === 0) return false;
    return ctx.projectIds.has(projectId);
  }

  size(): number {
    return this.clients.size;
  }
}

function extractProjectId(event: WsJobEvent): string | null {
  const payload = event.payload as { projectId?: string; job?: { projectId?: string } };
  return payload?.projectId ?? payload?.job?.projectId ?? null;
}

let hub: WsHub | null = null;

export function getWsHub(): WsHub | null {
  return hub;
}

export function initWsHub(): WsHub {
  hub = new WsHub();
  return hub;
}
