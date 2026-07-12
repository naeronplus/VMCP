import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { DispatchInputs, WorkerTier } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';

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

  async dispatchWorkflow(inputs: DispatchInputs): Promise<{ dispatched: boolean; mock?: boolean }> {
    const env = getEnv();
    const octokit = await this.client();

    if (!octokit) {
      // Dev mock only (GITHUB_MOCK=true)
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
      return { status: 'completed', conclusion: 'success' };
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
