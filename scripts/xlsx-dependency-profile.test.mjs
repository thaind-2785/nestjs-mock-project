import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

const workerUrl = new URL(
  './xlsx-dependency-profile.worker.mjs',
  import.meta.url,
);

/** The caps the owner accepted in SPEC-009 on 2026-09-17. */
const acceptedRows = 10_000;
const acceptedOldGenerationMb = 128;
const acceptedGenerationTimeoutMs = 60_000;
const acceptedFileBytes = 25 * 1_024 * 1_024;

/**
 * The measured profile must keep real headroom under the cap, not merely fit.
 * ADR-0007 recorded a peak near 53 MiB against 128 MiB; a release that spends three
 * quarters of the heap has changed the profile that decision rests on, even though it
 * has not failed yet.
 */
const peakHeapCeilingBytes = 96 * 1_024 * 1_024;

function profile(resourceLimits) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        rows: acceptedRows,
        maxOldGenerationMb: acceptedOldGenerationMb,
      },
      resourceLimits,
    });
    let message;
    worker.once('message', (value) => {
      message = value;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`worker exited with ${code}`));
      if (!message) return reject(new Error('worker exited without a result'));
      resolve(message);
    });
  });
}

// One measurement at the accepted maximum, because that is the only point where the
// caps are actually load-bearing.
test('the pinned XLSX dependency generates the maximum fixture inside the accepted limits', async () => {
  const result = await profile({
    maxOldGenerationSizeMb: acceptedOldGenerationMb,
  });

  assert.equal(result.appliedOldGenerationMb, acceptedOldGenerationMb);
  assert.equal(result.rows, acceptedRows);
  assert.ok(
    result.peakHeapBytes < peakHeapCeilingBytes,
    `peak heap ${(result.peakHeapBytes / 1_048_576).toFixed(1)} MiB left too little headroom under the ${acceptedOldGenerationMb} MiB cap`,
  );
  assert.ok(
    result.outputBytes > 0 && result.outputBytes < acceptedFileBytes,
    `output ${result.outputBytes} bytes is outside the accepted file limit`,
  );
  assert.ok(
    result.durationMs < acceptedGenerationTimeoutMs,
    `generation took ${result.durationMs.toFixed(0)} ms against a ${acceptedGenerationTimeoutMs} ms timeout`,
  );
});

// The guard that makes every number above mean anything. Node ignores an unknown
// `resourceLimits` key in silence, so this misspelling starts a thread with the
// default multi-gigabyte heap; the first run of the ADR-0007 benchmark did exactly
// that and passed a 128 MiB cap while peaking at 151 MiB.
test('a resource limit that silently did not apply fails instead of measuring', async () => {
  await assert.rejects(
    profile({ oldGenerationSizeMb: acceptedOldGenerationMb }),
    /maxOldGenerationSizeMb/,
  );
});
