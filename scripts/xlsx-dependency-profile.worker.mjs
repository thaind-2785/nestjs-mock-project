import { createRequire } from 'node:module';
import { resourceLimits, parentPort, workerData } from 'node:worker_threads';
import { Writable } from 'node:stream';

const require = createRequire(import.meta.url);

/**
 * Measures the pinned XLSX dependency under the accepted Worker Thread limits.
 *
 * This is deliberately not the production generator, which arrives with the snapshot
 * reader: it is a guard on the library. ADR-0007 chose `exceljs` in streaming mode
 * against measured peak heap, and an upgrade that quietly changes that profile has to
 * fail here rather than ship and then abort a worker process in production.
 */

// Reading the applied limits back is the first thing the thread does, because Node
// accepts an unknown `resourceLimits` key in silence. `oldGenerationSizeMb`, the
// plausible misspelling of `maxOldGenerationSizeMb`, starts a thread with the default
// multi-gigabyte heap and no warning, and every number measured under it describes a
// different machine than the one being reported.
if (resourceLimits.maxOldGenerationSizeMb !== workerData.maxOldGenerationMb) {
  throw new Error(
    `applied maxOldGenerationSizeMb ${String(resourceLimits.maxOldGenerationSizeMb)} is not the configured ${workerData.maxOldGenerationMb}`,
  );
}

const ExcelJS = require('exceljs');

/** One row in twenty carries a prefix a spreadsheet would otherwise read as a formula. */
const dangerousPrefixes = ['=', '+', '-', '@'];

/**
 * The widest cell, at the width the accepted room contract actually permits:
 * `ArrayMaxSize(100)` amenities per room, `amenities.code VARCHAR(50)` and
 * `amenities.name VARCHAR(100)`.
 *
 * Every value is distinct per row, which is the part the first version of this
 * benchmark got wrong. Shared strings store one copy of a repeated value, so a fixture
 * that reuses one amenity string measures deduplication rather than the input: it
 * reported 34 MiB where the same shape with distinct values reaches 68.
 */
function amenitiesFor(index) {
  const width = Math.max(
    1,
    Math.floor(workerData.charsPerRow / amenitiesPerRoom) - 5,
  );
  const half = Math.floor(width / 2);
  return Array.from({ length: amenitiesPerRoom }, (_unused, slot) => {
    const seed = `R${index}A${slot}`;
    return `${seed.padStart(half, 'C')} - ${seed.padStart(width - half, 'N')}`;
  }).join('; ');
}

function cellValues(index) {
  const dangerous = index % 20 === 0;
  const prefix = dangerousPrefixes[index % dangerousPrefixes.length];
  return [
    String(9_000_000_000_000_000 + index),
    dangerous ? `${prefix}A-${index}` : `A-${index}`,
    'Deluxe double with balcony',
    (index % 4) + 1,
    index % 3 === 0 ? '' : 'CITY',
    String(1_000_000 + index * 13),
    'VND',
    index % 7 === 0 ? 'INACTIVE' : 'ACTIVE',
    amenitiesFor(index),
    String((index % 50) + 1),
    new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    new Date(Date.UTC(2026, 6, 1, 0, 0, index % 60)).toISOString(),
  ];
}

const amenitiesPerRoom = workerData.amenitiesPerRoom;

const header = [
  'Room ID',
  'Room number',
  'Room type',
  'Beds',
  'View',
  'Base price (minor units)',
  'Currency',
  'Status',
  'Amenities',
  'Version',
  'Created at (UTC)',
  'Updated at (UTC)',
];

let outputBytes = 0;
const chunks = [];
const sink = new Writable({
  write(chunk, _encoding, done) {
    outputBytes += chunk.length;
    // Retained, because production must return the whole buffer to the parent by
    // transfer. Counting the bytes and dropping them measures a shape no deployment
    // ever runs.
    chunks.push(chunk);
    done();
  },
});

let peakHeapBytes = process.memoryUsage().heapUsed;
const sampler = setInterval(() => {
  const { heapUsed } = process.memoryUsage();
  if (heapUsed > peakHeapBytes) peakHeapBytes = heapUsed;
}, 20);

const startedAt = process.hrtime.bigint();
const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
  stream: sink,
  useStyles: true,
  // Shared strings cost roughly 20 MiB and buy the `t="s"` literal-string encoding
  // SPEC-009 requires. With them off exceljs emits `t="str"`, which OOXML defines as
  // a cached formula string result.
  useSharedStrings: true,
});
const sheet = workbook.addWorksheet('Rooms');
sheet.addRow(header).commit();
for (let index = 0; index < workerData.rows; index += 1) {
  sheet.addRow(cellValues(index)).commit();
}
sheet.commit();
await workbook.commit();
const output = Buffer.concat(chunks);
const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

clearInterval(sampler);
const { heapUsed } = process.memoryUsage();
if (heapUsed > peakHeapBytes) peakHeapBytes = heapUsed;

parentPort.postMessage({
  rows: workerData.rows,
  durationMs,
  peakHeapBytes,
  outputBytes,
  retainedBytes: output.byteLength,
  appliedOldGenerationMb: resourceLimits.maxOldGenerationSizeMb,
});
