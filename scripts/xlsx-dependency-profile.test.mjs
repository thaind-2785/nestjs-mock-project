import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

const workerUrl = new URL(
  './xlsx-dependency-profile.worker.mjs',
  import.meta.url,
);

/** The caps the owner accepted in SPEC-009, as revised by REVIEW-038. */
const acceptedRows = 10_000;
const acceptedSnapshotChars = 20_000_000;
const acceptedOldGenerationMb = 128;
const acceptedGenerationTimeoutMs = 60_000;
const acceptedFileBytes = 25 * 1_024 * 1_024;

/**
 * The measured profile must keep real headroom under the cap, not merely fit.
 * ADR-0007 records a peak near 68 MiB at the accepted volume; a release that spends
 * three quarters of the heap has changed the profile that decision rests on, even
 * though it has not failed yet.
 */
const peakHeapCeilingBytes = 96 * 1_024 * 1_024;

function profile({ resourceLimits, rows, charsPerRow, amenitiesPerRoom }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        rows,
        charsPerRow,
        amenitiesPerRoom,
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

const atAcceptedVolume = {
  resourceLimits: { maxOldGenerationSizeMb: acceptedOldGenerationMb },
  rows: acceptedRows,
  charsPerRow: acceptedSnapshotChars / acceptedRows,
  amenitiesPerRoom: 12,
};

// One measurement at the accepted maximum, because that is the only point where the
// caps are actually load-bearing.
test('the pinned XLSX dependency generates the maximum accepted snapshot inside the limits', async () => {
  const result = await profile(atAcceptedVolume);

  assert.equal(result.appliedOldGenerationMb, acceptedOldGenerationMb);
  assert.equal(result.rows, acceptedRows);
  // The buffer is retained, not counted and dropped: production transfers it back.
  assert.equal(result.retainedBytes, result.outputBytes);
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

// The measurement that makes the character cap load-bearing rather than decorative.
// REVIEW-038 found the row cap alone does not bound memory: the room contract permits
// 100 amenities of maximum width, so 10,000 legal rows reach roughly 155 million
// characters. This is that input, and it must fail rather than produce a workbook.
test('a snapshot past the accepted character volume exhausts the heap', async () => {
  await assert.rejects(
    profile({
      resourceLimits: { maxOldGenerationSizeMb: acceptedOldGenerationMb },
      rows: acceptedRows,
      // 100 amenities at 50-character codes and 100-character names.
      charsPerRow: 15_500,
      amenitiesPerRoom: 100,
    }),
    /memory limit|out of memory|exited with/i,
  );
});

// The guard that makes every number above mean anything. Node ignores an unknown
// `resourceLimits` key in silence, so this misspelling starts a thread with the
// default multi-gigabyte heap; the first run of the ADR-0007 benchmark did exactly
// that and passed a 128 MiB cap while peaking at 151 MiB.
test('a resource limit that silently did not apply fails instead of measuring', async () => {
  await assert.rejects(
    profile({
      ...atAcceptedVolume,
      resourceLimits: { oldGenerationSizeMb: acceptedOldGenerationMb },
    }),
    /maxOldGenerationSizeMb/,
  );
});
