import type { Worker } from 'bullmq';

let workers: Worker[] = [];

export function registerWorkers(list: Worker[]): void {
  workers = list;
}

export async function closeWorkers(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
}