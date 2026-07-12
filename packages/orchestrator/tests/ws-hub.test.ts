/**
 * TEST-02: WebSocket hub RBAC + subscribe filter (plan §8.2).
 *
 * Covers pure mayReceiveJobEvent, extractProjectId, subscribe handling, and
 * end-to-end WsHub.broadcast filtering with mock sockets (no shortcuts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WsJobEvent } from '@vibrato/shared';
import type { WebSocket } from 'ws';
import {
  createWsHub,
  extractProjectId,
  handleWsClientMessage,
  mayReceiveJobEvent,
  type WsClientContext,
} from '../src/lib/ws-hub.js';

function ctx(
  role: string,
  projectIds: string[] = [],
): WsClientContext {
  return { role, projectIds: new Set(projectIds) };
}

function jobEvent(
  projectId: string | null,
  nested = false,
): WsJobEvent {
  const payload =
    projectId === null
      ? { note: 'global' }
      : nested
        ? { job: { projectId } }
        : { projectId };
  return {
    type: 'job.updated',
    payload,
    at: new Date().toISOString(),
  };
}

/** Minimal WebSocket stand-in for hub.broadcast / message subscribe tests. */
class MockSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  /** Deliver a client control frame as the hub's `message` listener expects. */
  clientMessage(raw: string): void {
    this.emit('message', raw);
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

describe('ws-hub mayReceiveJobEvent (TEST-02)', () => {
  it('admin receives all project IDs', () => {
    const c = ctx('admin');
    assert.equal(mayReceiveJobEvent(c, 'projectA'), true);
    assert.equal(mayReceiveJobEvent(c, 'projectB'), true);
  });

  it('operator receives all project IDs', () => {
    const c = ctx('operator');
    assert.equal(mayReceiveJobEvent(c, 'projectA'), true);
    assert.equal(mayReceiveJobEvent(c, 'projectB'), true);
  });

  it('viewer with empty projectIds receives nothing for scoped events', () => {
    const c = ctx('viewer');
    assert.equal(mayReceiveJobEvent(c, 'projectA'), false);
    assert.equal(mayReceiveJobEvent(c, 'projectB'), false);
  });

  it('viewer subscribed to projectA receives A not B', () => {
    const c = ctx('viewer', ['projectA']);
    assert.equal(mayReceiveJobEvent(c, 'projectA'), true);
    assert.equal(mayReceiveJobEvent(c, 'projectB'), false);
  });

  it('event without projectId is delivered to all roles (global events)', () => {
    // Documented behavior: null projectId is global — every connected client.
    assert.equal(mayReceiveJobEvent(ctx('viewer'), null), true);
    assert.equal(mayReceiveJobEvent(ctx('viewer', []), null), true);
    assert.equal(mayReceiveJobEvent(ctx('admin'), null), true);
    assert.equal(mayReceiveJobEvent(ctx('operator'), null), true);
  });

  it('subscribe message updates viewer filter', () => {
    const c = ctx('viewer');
    assert.equal(mayReceiveJobEvent(c, 'projectA'), false);

    handleWsClientMessage(
      c,
      JSON.stringify({ type: 'subscribe', projectIds: ['projectA'] }),
    );
    assert.equal(mayReceiveJobEvent(c, 'projectA'), true);
    assert.equal(mayReceiveJobEvent(c, 'projectB'), false);

    handleWsClientMessage(
      c,
      JSON.stringify({ type: 'subscribe', projectIds: ['projectB', 'projectC'] }),
    );
    assert.equal(mayReceiveJobEvent(c, 'projectA'), false);
    assert.equal(mayReceiveJobEvent(c, 'projectB'), true);
    assert.equal(mayReceiveJobEvent(c, 'projectC'), true);
  });

  it('malformed subscribe messages are ignored', () => {
    const c = ctx('viewer', ['projectA']);
    handleWsClientMessage(c, 'not-json');
    assert.equal(mayReceiveJobEvent(c, 'projectA'), true);
    handleWsClientMessage(c, JSON.stringify({ type: 'subscribe' }));
    assert.equal(mayReceiveJobEvent(c, 'projectA'), true);
    handleWsClientMessage(
      c,
      JSON.stringify({ type: 'other', projectIds: ['projectB'] }),
    );
    assert.equal(mayReceiveJobEvent(c, 'projectA'), true);
    assert.equal(mayReceiveJobEvent(c, 'projectB'), false);
  });
});

describe('ws-hub extractProjectId (TEST-02)', () => {
  it('reads top-level payload.projectId', () => {
    assert.equal(extractProjectId(jobEvent('projectA')), 'projectA');
  });

  it('reads nested payload.job.projectId', () => {
    assert.equal(extractProjectId(jobEvent('projectB', true)), 'projectB');
  });

  it('returns null when event has no project scope (global)', () => {
    assert.equal(extractProjectId(jobEvent(null)), null);
  });
});

describe('ws-hub broadcast filtering (TEST-02)', () => {
  it('admin receives all projects; viewer only subscribed', () => {
    const hub = createWsHub();
    const admin = new MockSocket();
    const viewer = new MockSocket();
    hub.add(admin.asWebSocket(), ctx('admin'));
    hub.add(viewer.asWebSocket(), ctx('viewer', ['projectA']));

    hub.broadcast(jobEvent('projectA'));
    hub.broadcast(jobEvent('projectB'));

    assert.equal(admin.sent.length, 2);
    assert.equal(viewer.sent.length, 1);
    const received = JSON.parse(viewer.sent[0]!) as WsJobEvent;
    assert.equal((received.payload as { projectId: string }).projectId, 'projectA');
  });

  it('global event (no projectId) is delivered to all connected clients', () => {
    const hub = createWsHub();
    const emptyViewer = new MockSocket();
    const scopedViewer = new MockSocket();
    const operator = new MockSocket();
    hub.add(emptyViewer.asWebSocket(), ctx('viewer'));
    hub.add(scopedViewer.asWebSocket(), ctx('viewer', ['projectA']));
    hub.add(operator.asWebSocket(), ctx('operator'));

    hub.broadcast(jobEvent(null));

    assert.equal(emptyViewer.sent.length, 1);
    assert.equal(scopedViewer.sent.length, 1);
    assert.equal(operator.sent.length, 1);
  });

  it('viewer with empty projectIds receives no scoped events via broadcast', () => {
    const hub = createWsHub();
    const viewer = new MockSocket();
    hub.add(viewer.asWebSocket(), ctx('viewer'));
    hub.broadcast(jobEvent('projectA'));
    assert.equal(viewer.sent.length, 0);
  });

  it('subscribe message on socket updates viewer filter for subsequent broadcasts', () => {
    const hub = createWsHub();
    const viewer = new MockSocket();
    hub.add(viewer.asWebSocket(), ctx('viewer'));

    hub.broadcast(jobEvent('projectA'));
    assert.equal(viewer.sent.length, 0);

    viewer.clientMessage(
      JSON.stringify({ type: 'subscribe', projectIds: ['projectA'] }),
    );
    hub.broadcast(jobEvent('projectA'));
    hub.broadcast(jobEvent('projectB'));
    assert.equal(viewer.sent.length, 1);
    assert.equal(
      (JSON.parse(viewer.sent[0]!).payload as { projectId: string }).projectId,
      'projectA',
    );
  });

  it('skips sockets that are not OPEN (readyState !== 1)', () => {
    const hub = createWsHub();
    const closed = new MockSocket();
    closed.readyState = 3;
    hub.add(closed.asWebSocket(), ctx('admin'));
    hub.broadcast(jobEvent('projectA'));
    assert.equal(closed.sent.length, 0);
  });

  it('nested job.projectId scopes broadcast the same as top-level projectId', () => {
    const hub = createWsHub();
    const viewer = new MockSocket();
    hub.add(viewer.asWebSocket(), ctx('viewer', ['projectA']));
    hub.broadcast(jobEvent('projectA', true));
    hub.broadcast(jobEvent('projectB', true));
    assert.equal(viewer.sent.length, 1);
  });

  it('size tracks connected clients and drops on close', () => {
    const hub = createWsHub();
    const a = new MockSocket();
    const b = new MockSocket();
    hub.add(a.asWebSocket(), ctx('admin'));
    hub.add(b.asWebSocket(), ctx('viewer', ['p1']));
    assert.equal(hub.size(), 2);
    a.close();
    assert.equal(hub.size(), 1);
  });
});
