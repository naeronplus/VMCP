import { parentPort, workerData } from 'node:worker_threads';

// Network egress blocked unless network flag is true
if (workerData.network === false && workerData.inputs?.fetchUrl) {
  parentPort.postMessage({ error: 'NETWORK_DENIED: network disabled for this invocation' });
} else if (
  workerData.network === true &&
  workerData.inputs?.fetchUrl &&
  Array.isArray(workerData.approvedDomains)
) {
  try {
    const host = new URL(workerData.inputs.fetchUrl).hostname;
    if (!workerData.approvedDomains.includes(host)) {
      parentPort.postMessage({
        error: `NETWORK_DENIED: domain ${host} not in approved list`,
      });
    } else {
      parentPort.postMessage({
        ok: true,
        extensionId: workerData.extensionId,
        echo: workerData.inputs,
        sandbox: 'worker_thread',
      });
    }
  } catch (e) {
    parentPort.postMessage({ error: String(e) });
  }
} else {
  parentPort.postMessage({
    ok: true,
    extensionId: workerData.extensionId,
    echo: workerData.inputs,
    sandbox: 'worker_thread',
  });
}
