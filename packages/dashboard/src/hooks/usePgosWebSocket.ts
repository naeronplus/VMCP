import { useEffect, useRef, useCallback } from 'react';

export type WsEvent = {
  type: string;
  payload: unknown;
  at: string;
};

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export function usePgosWebSocket(opts: {
  projectIds: string[];
  onEvent: (event: WsEvent) => void;
  enabled?: boolean;
}) {
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;

  const subscribe = useCallback((ws: WebSocket, projectIds: string[]) => {
    if (projectIds.length > 0) {
      ws.send(JSON.stringify({ type: 'subscribe', projectIds }));
    }
  }, []);

  useEffect(() => {
    if (opts.enabled === false) return;

    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      ws.onopen = () => {
        attempt = 0;
        subscribe(ws!, opts.projectIds);
      };

      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string) as WsEvent;
          onEventRef.current(data);
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onclose = () => {
        if (closed) return;
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [opts.projectIds.join(','), opts.enabled, subscribe]);
}