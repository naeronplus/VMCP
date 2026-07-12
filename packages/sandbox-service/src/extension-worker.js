import { parentPort, workerData } from 'node:worker_threads';

/**
 * Isolated extension worker (worker_threads stand-in for Firecracker policy surface).
 * Enforces:
 *  - network deny unless network=true (+ approvedDomains for fetchUrl)
 *  - optional sleepMs (timeout kill tests / slow extensions)
 *  - optional allocateMiB (memory limit / resourceLimits tests)
 */

function finish(msg) {
  parentPort.postMessage(msg);
}

function runNetworkGate() {
  if (workerData.network === false && workerData.inputs?.fetchUrl) {
    finish({ error: 'NETWORK_DENIED: network disabled for this invocation' });
    return false;
  }
  if (
    workerData.network === true &&
    workerData.inputs?.fetchUrl &&
    Array.isArray(workerData.approvedDomains)
  ) {
    try {
      const host = new URL(workerData.inputs.fetchUrl).hostname;
      if (!workerData.approvedDomains.includes(host)) {
        finish({
          error: `NETWORK_DENIED: domain ${host} not in approved list`,
        });
        return false;
      }
    } catch (e) {
      finish({ error: String(e) });
      return false;
    }
  }
  return true;
}

function maybeAllocate() {
  const allocateMiB = Number(workerData.inputs?.allocateMiB ?? 0);
  if (!Number.isFinite(allocateMiB) || allocateMiB <= 0) return;
  // Pressure V8 old-space (resourceLimits maxOldGenerationSizeMb). Prefer
  // JS arrays over Buffer/TypedArray external memory so limits apply.
  const held = [];
  for (let m = 0; m < allocateMiB; m++) {
    // ~1 MiB-ish of retained object graph per iteration (approx.)
    held.push(new Array(16 * 1024).fill({ i: m, pad: 'x'.repeat(32) }));
  }
  workerData.__held = held;
}

function success() {
  finish({
    ok: true,
    extensionId: workerData.extensionId,
    echo: workerData.inputs,
    sandbox: 'worker_thread',
    allocatedMiB: Number(workerData.inputs?.allocateMiB ?? 0) || undefined,
  });
}

function main() {
  if (!runNetworkGate()) return;

  const sleepMs = Number(workerData.inputs?.sleepMs ?? 0);
  const doWork = () => {
    try {
      maybeAllocate();
      success();
    } catch (e) {
      finish({ error: String(e) });
    }
  };

  if (Number.isFinite(sleepMs) && sleepMs > 0) {
    setTimeout(doWork, sleepMs);
  } else {
    doWork();
  }
}

main();
