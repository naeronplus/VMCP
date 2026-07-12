import { satisfiesGodotRange, type ExecuteExtensionRequest } from '@vibrato/shared';
import { getEnv } from '../config/env.js';
import { getPool } from '../db/pool.js';
import { audit } from './audit-service.js';

export class ExtensionService {
  async getPolicy(extensionId: string) {
    const { rows } = await getPool().query(
      `SELECT * FROM extension_policies WHERE extension_id = $1`,
      [extensionId],
    );
    return rows[0] ?? null;
  }

  async listPolicies() {
    const { rows } = await getPool().query(
      `SELECT * FROM extension_policies ORDER BY name`,
    );
    return rows;
  }

  async listApprovals(status?: string) {
    if (status) {
      const { rows } = await getPool().query(
        `SELECT * FROM extension_approvals WHERE status = $1 ORDER BY created_at DESC`,
        [status],
      );
      return rows;
    }
    const { rows } = await getPool().query(
      `SELECT * FROM extension_approvals ORDER BY created_at DESC LIMIT 100`,
    );
    return rows;
  }

  async requestNetworkAccess(opts: {
    extensionId: string;
    requestedDomains: string[];
    reason: string;
    riskAssessment: string;
    requestedBy: string;
  }) {
    const { rows } = await getPool().query(
      `INSERT INTO extension_approvals
         (extension_id, requested_domains, reason, risk_assessment, requested_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        opts.extensionId,
        opts.requestedDomains,
        opts.reason,
        opts.riskAssessment,
        opts.requestedBy,
      ],
    );
    return rows[0];
  }

  async reviewApproval(
    id: string,
    status: 'approved' | 'rejected',
    reviewedBy: string,
  ) {
    const { rows } = await getPool().query(
      `UPDATE extension_approvals
       SET status = $2, reviewed_by = $3, reviewed_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, status, reviewedBy],
    );
    const approval = rows[0];
    if (!approval) throw new Error('Approval not found');
    if (status === 'approved') {
      await getPool().query(
        `UPDATE extension_policies
         SET network_allowed = true,
             approved_domains = (
               SELECT ARRAY(
                 SELECT DISTINCT unnest(approved_domains || $2::text[])
               )
             ),
             updated_at = now()
         WHERE extension_id = $1`,
        [approval.extension_id, approval.requested_domains],
      );
    }
    await audit({
      actorId: reviewedBy,
      actorRole: 'admin',
      action: `extension.approval_${status}`,
      resourceType: 'extension_approval',
      resourceId: id,
      detail: { extensionId: approval.extension_id },
    });
    return approval;
  }

  async upsertPolicy(policy: {
    extensionId: string;
    name: string;
    godotVersionRange?: string;
    maxCpu?: number;
    maxMemoryMiB?: number;
    maxDiskMiB?: number;
    timeoutSeconds?: number;
  }) {
    const { rows } = await getPool().query(
      `INSERT INTO extension_policies (
         extension_id, name, godot_version_range, max_cpu, max_memory_mib, max_disk_mib, timeout_seconds
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (extension_id) DO UPDATE SET
         name = EXCLUDED.name,
         godot_version_range = EXCLUDED.godot_version_range,
         max_cpu = EXCLUDED.max_cpu,
         max_memory_mib = EXCLUDED.max_memory_mib,
         max_disk_mib = EXCLUDED.max_disk_mib,
         timeout_seconds = EXCLUDED.timeout_seconds,
         updated_at = now()
       RETURNING *`,
      [
        policy.extensionId,
        policy.name,
        policy.godotVersionRange ?? '>=4.2, <5.0',
        policy.maxCpu ?? 1,
        policy.maxMemoryMiB ?? 512,
        policy.maxDiskMiB ?? 1024,
        policy.timeoutSeconds ?? 60,
      ],
    );
    return rows[0];
  }

  /**
   * Proxy to sandboxed execution service (§10.1).
   * Network only if approved; version range enforced.
   */
  async execute(
    req: ExecuteExtensionRequest,
    actorId: string,
  ): Promise<{ result: unknown; error?: string; code?: string }> {
    const policy = await this.getPolicy(req.extensionId);
    if (!policy) {
      return { result: null, error: 'Unknown extension', code: 'E017' };
    }

    const { rows: projects } = await getPool().query(
      `SELECT godot_version FROM projects WHERE id = $1`,
      [req.projectId],
    );
    if (!projects[0]) {
      return { result: null, error: 'Project not found' };
    }
    if (!satisfiesGodotRange(projects[0].godot_version, policy.godot_version_range)) {
      return {
        result: null,
        error: `Extension incompatible with Godot ${projects[0].godot_version}`,
        code: 'E017',
      };
    }

    if (req.network && !policy.network_allowed) {
      return {
        result: null,
        error: 'Network access not approved for this extension',
        code: 'E016',
      };
    }

    // Validate requested network domains against approved list
    if (req.network && Array.isArray((req.inputs as { domains?: string[] }).domains)) {
      const domains = (req.inputs as { domains: string[] }).domains;
      for (const d of domains) {
        if (!policy.approved_domains.includes(d)) {
          return {
            result: null,
            error: `Domain not approved: ${d}`,
            code: 'E016',
          };
        }
      }
    }

    const env = getEnv();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      (policy.timeout_seconds + 5) * 1000,
    );

    try {
      const res = await fetch(`${env.SANDBOX_SERVICE_URL}/v1/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SANDBOX_INTERNAL_TOKEN}`,
        },
        body: JSON.stringify({
          extensionId: req.extensionId,
          inputs: req.inputs,
          network: Boolean(req.network && policy.network_allowed),
          approvedDomains: policy.approved_domains,
          limits: {
            cpu: Number(policy.max_cpu),
            memoryMiB: policy.max_memory_mib,
            diskMiB: policy.max_disk_mib,
            timeoutSeconds: policy.timeout_seconds,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 504 || text.includes('timeout')) {
          return { result: null, error: text, code: 'E009' };
        }
        return { result: null, error: text };
      }
      const result = await res.json();
      await audit({
        actorId,
        action: 'extension.executed',
        resourceType: 'extension',
        resourceId: req.extensionId,
        detail: { projectId: req.projectId, network: req.network },
      });
      return { result };
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('abort')) {
        return { result: null, error: 'Extension execution timeout', code: 'E009' };
      }
      return { result: null, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const extensionService = new ExtensionService();
