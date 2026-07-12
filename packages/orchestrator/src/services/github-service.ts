import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { DispatchInputs, WorkerTier } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';
import {
  evaluateTierBFromWorkflowRuns,
  mockTierBProbeHealthy,
  type TierBProbeResult,
  type WorkflowRunSummary,
} from './tier-probe.js';

/** Scheduled health probe workflow (Tier B ubuntu-latest signal). */
export const DEFAULT_HEALTH_WORKFLOW_FILE = 'godot_health.yml';

/** Error code used when mock or real workflow_dispatch fails (maps to E001 path). */
export const GITHUB_DISPATCH_ERROR_CODE = 'GITHUB_DISPATCH_FAILED' as const;

export class GitHubDispatchError extends Error {
  readonly code = GITHUB_DISPATCH_ERROR_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'GitHubDispatchError';
  }
}

/**
 * Pure helpers for M-18 mock failure simulation (unit-testable without Octokit).
 */
export function shouldSimulateMockDispatchFailure(env: {
  GITHUB_MOCK: boolean;
  GITHUB_MOCK_DISPATCH_FAIL: boolean;
}): boolean {
  return Boolean(env.GITHUB_MOCK && env.GITHUB_MOCK_DISPATCH_FAIL);
}

export function mockGetRunStatusResult(env: {
  GITHUB_MOCK: boolean;
  GITHUB_MOCK_RUN_CONCLUSION: string;
}): { status: string | null; conclusion: string | null } {
  if (!env.GITHUB_MOCK) {
    throw new Error('mockGetRunStatusResult only applies when GITHUB_MOCK=true');
  }
  const conclusion = env.GITHUB_MOCK_RUN_CONCLUSION || 'success';
  return {
    status: 'completed',
    conclusion,
  };
}

/**
 * Push-based worker dispatch via workflow_dispatch (§2.3).
 * Never waits for runners to poll PGOS.
 */
export class GitHubService {
  private mockRunCounter = 10_000;

  private async client(): Promise<Octokit | null> {
    const env = getEnv();
    if (env.GITHUB_MOCK) {
      return null;
    }
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
      throw new Error(
        'GitHub App credentials missing (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID). Set GITHUB_MOCK=true for local development.',
      );
    }
    const auth = createAppAuth({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'),
      installationId: Number(env.GITHUB_APP_INSTALLATION_ID),
    });
    const installationAuth = await auth({ type: 'installation' });
    return new Octokit({ auth: installationAuth.token });
  }

  healthWorkflowFile(): string {
    return (
      process.env.GITHUB_HEALTH_WORKFLOW_FILE?.trim() ||
      DEFAULT_HEALTH_WORKFLOW_FILE
    );
  }

  /**
   * M-04: Real Tier B probe via GitHub Actions API.
   * Uses recent godot_health.yml (and worker) runs as proof that ubuntu-latest
   * can schedule work — not Redis/Postgres latency.
   */
  async probeTierBAvailability(): Promise<TierBProbeResult> {
    const env = getEnv();
    const octokit = await this.client();
    if (!octokit) {
      return mockTierBProbeHealthy();
    }

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    if (!owner || !repo) {
      return evaluateTierBFromWorkflowRuns({
        actionsApiOk: false,
        healthRuns: [],
      });
    }

    try {
      const healthWorkflow = this.healthWorkflowFile();
      const healthRuns = await this.listRecentWorkflowRuns(
        octokit,
        owner,
        repo,
        healthWorkflow,
        10,
      );

      // Fallback: recent godot_worker runs also prove hosted runners work
      let otherRuns: WorkflowRunSummary[] = [];
      try {
        otherRuns = await this.listRecentWorkflowRuns(
          octokit,
          owner,
          repo,
          env.GITHUB_WORKFLOW_FILE,
          5,
        );
      } catch {
        // worker workflow missing in some forks — ignore
      }

      return evaluateTierBFromWorkflowRuns({
        actionsApiOk: true,
        healthRuns,
        otherRuns,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[github] Tier B probe failed', message);
      return evaluateTierBFromWorkflowRuns({
        actionsApiOk: false,
        healthRuns: [],
      });
    }
  }

  private async listRecentWorkflowRuns(
    octokit: Octokit,
    owner: string,
    repo: string,
    workflowId: string,
    perPage: number,
  ): Promise<WorkflowRunSummary[]> {
    const { data } = await octokit.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowId,
      per_page: perPage,
    });
    return (data.workflow_runs ?? []).map((run) => ({
      id: run.id,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      runStartedAt:
        (run as { run_started_at?: string | null }).run_started_at ?? null,
      event: run.event ?? null,
      name: run.name ?? null,
    }));
  }

  async dispatchWorkflow(inputs: DispatchInputs): Promise<{ dispatched: boolean; mock?: boolean }> {
    const env = getEnv();
    const octokit = await this.client();

    if (!octokit) {
      // Dev mock only (GITHUB_MOCK=true)
      // M-18: optional failure injection for local E2E of DISPATCH_FAILED path
      if (
        shouldSimulateMockDispatchFailure({
          GITHUB_MOCK: env.GITHUB_MOCK,
          GITHUB_MOCK_DISPATCH_FAIL: env.GITHUB_MOCK_DISPATCH_FAIL,
        })
      ) {
        throw new GitHubDispatchError(
          'GITHUB_MOCK_DISPATCH_FAIL: simulated workflow_dispatch failure',
        );
      }
      const mockRunId = ++this.mockRunCounter;
      await getPool().query(
        `UPDATE jobs SET github_run_id = $1, metadata = metadata || $2::jsonb, updated_at = now()
         WHERE id = $3`,
        [
          mockRunId,
          JSON.stringify({ mockDispatch: true, inputs }),
          inputs.jobId,
        ],
      );
      return { dispatched: true, mock: true };
    }

    const labels =
      inputs.tier === 'A' ? { runner_label: 'godot-worker' } : { runner_label: 'ubuntu-latest' };

    try {
      await octokit.actions.createWorkflowDispatch({
        owner: env.GITHUB_OWNER,
        repo: env.GITHUB_REPO,
        workflow_id: env.GITHUB_WORKFLOW_FILE,
        ref: env.GITHUB_DEFAULT_REF,
        inputs: {
          jobId: inputs.jobId,
          projectId: inputs.projectId,
          godotVersion: inputs.godotVersion,
          commitStrategy: inputs.commitStrategy,
          tier: inputs.tier,
          secretJwe: inputs.secretJwe,
          ...labels,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GitHubDispatchError(`workflow_dispatch failed: ${message}`);
    }
    return { dispatched: true };
  }

  /**
   * Dispatch an arbitrary workflow_dispatch file (H-02 merge_apply, H-03 uid_reconcile).
   * Inputs must be string values (GitHub Actions constraint).
   */
  async dispatchWorkflowFile(
    workflowId: string,
    inputs: Record<string, string>,
  ): Promise<{ dispatched: boolean; mock?: boolean; mockRunId?: number }> {
    const env = getEnv();
    const octokit = await this.client();

    if (!octokit) {
      if (
        shouldSimulateMockDispatchFailure({
          GITHUB_MOCK: env.GITHUB_MOCK,
          GITHUB_MOCK_DISPATCH_FAIL: env.GITHUB_MOCK_DISPATCH_FAIL,
        })
      ) {
        throw new GitHubDispatchError(
          'GITHUB_MOCK_DISPATCH_FAIL: simulated workflow_dispatch failure',
        );
      }
      const mockRunId = ++this.mockRunCounter;
      // No job row required for maintenance workflows — audit via caller
      return { dispatched: true, mock: true, mockRunId };
    }

    const owner = env.GITHUB_OWNER;
    const repo = env.GITHUB_REPO;
    if (!owner || !repo) {
      throw new GitHubDispatchError(
        'GITHUB_OWNER/GITHUB_REPO required for named workflow dispatch',
      );
    }

    try {
      await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: workflowId,
        ref: env.GITHUB_DEFAULT_REF,
        inputs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GitHubDispatchError(
        `workflow_dispatch ${workflowId} failed: ${message}`,
      );
    }
    return { dispatched: true };
  }

  /**
   * Resolve run_id by polling workflow_dispatch runs and matching jobId in inputs.
   */
  async resolveRunId(jobId: string, timeoutMs?: number): Promise<number | null> {
    const env = getEnv();
    const timeout = timeoutMs ?? env.DISPATCH_TIMEOUT_MS;
    const interval = env.DISPATCH_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeout;

    const octokit = await this.client();
    if (!octokit) {
      // Mock: already stored on dispatch
      const { rows } = await getPool().query(
        `SELECT github_run_id FROM jobs WHERE id = $1`,
        [jobId],
      );
      return rows[0]?.github_run_id ?? null;
    }

    while (Date.now() < deadline) {
      const { data } = await octokit.actions.listWorkflowRuns({
        owner: env.GITHUB_OWNER,
        repo: env.GITHUB_REPO,
        workflow_id: env.GITHUB_WORKFLOW_FILE,
        event: 'workflow_dispatch',
        branch: env.GITHUB_DEFAULT_REF,
        per_page: 20,
      });

      for (const run of data.workflow_runs) {
        // workflow sets name: "PGOS job ${{ inputs.jobId }}"
        const runName = run.name ?? '';
        const displayTitle = run.display_title ?? '';
        if (
          runName === `PGOS job ${jobId}` ||
          runName.includes(jobId) ||
          displayTitle.includes(jobId)
        ) {
          return run.id;
        }
      }
      await sleep(interval);
    }
    return null;
  }

  async cancelRun(runId: number): Promise<void> {
    const env = getEnv();
    const octokit = await this.client();
    if (!octokit) return;
    await octokit.actions.cancelWorkflowRun({
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      run_id: runId,
    });
  }

  async getRunStatus(runId: number): Promise<{
    status: string | null;
    conclusion: string | null;
  }> {
    const env = getEnv();
    const octokit = await this.client();
    if (!octokit) {
      // M-18: configurable mock conclusion (default success)
      return mockGetRunStatusResult({
        GITHUB_MOCK: true,
        GITHUB_MOCK_RUN_CONCLUSION: env.GITHUB_MOCK_RUN_CONCLUSION,
      });
    }
    const { data } = await octokit.actions.getWorkflowRun({
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      run_id: runId,
    });
    return { status: data.status, conclusion: data.conclusion };
  }

  runnerLabelsForTier(tier: WorkerTier): string[] {
    return tier === 'A' ? ['self-hosted', 'godot-worker'] : ['ubuntu-latest'];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const githubService = new GitHubService();
