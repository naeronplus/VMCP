import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

type JobRow = { id: string; projectId: string; status: string };

function applyJobUpdate(
  prev: JobRow[],
  updated: JobRow,
  projectId: string,
): JobRow[] {
  const idx = prev.findIndex((j) => j.id === updated.id);
  if (idx >= 0) {
    const next = [...prev];
    next[idx] = { ...next[idx], ...updated };
    return next;
  }
  if (!projectId || updated.projectId === projectId) {
    return [updated, ...prev];
  }
  return prev;
}

describe('JobsPage project filter', () => {
  const jobs: JobRow[] = [
    { id: 'j1', projectId: 'p1', status: 'STAGING' },
    { id: 'j2', projectId: 'p2', status: 'QUEUED' },
  ];

  it('updates existing job in list', () => {
    const next = applyJobUpdate(jobs, { id: 'j1', projectId: 'p1', status: 'COMPLETED' }, 'p1');
    assert.equal(next[0].status, 'COMPLETED');
    assert.equal(next.length, 2);
  });

  it('ignores new jobs from other projects when filter active', () => {
    const next = applyJobUpdate(jobs, { id: 'j3', projectId: 'p2', status: 'QUEUED' }, 'p1');
    assert.equal(next.length, 2);
    assert.equal(next.find((j) => j.id === 'j3'), undefined);
  });

  it('prepends new jobs matching project filter', () => {
    const next = applyJobUpdate(jobs, { id: 'j4', projectId: 'p1', status: 'QUEUED' }, 'p1');
    assert.equal(next[0].id, 'j4');
    assert.equal(next.length, 3);
  });
});