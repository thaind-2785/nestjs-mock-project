import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { createReportsConfiguration } from '../config/reports.config';
import type { ReportsConfiguration } from '../config/reports.config';
import { validateEnvironment } from '../config/environment.validation';
import {
  RoomExportGeneratorService,
  workerEntrypoint,
} from './room-export-generator.service';
import { toWorkbookRows } from './room-export-workbook';
import { roomExportWorksheetColumns } from './room-export-workbook.constants';
import {
  roomExportWorkerErrorCodes,
  RoomExportProtocolError,
} from './room-export.protocol';
import type { RoomSnapshotRow } from './room-export-snapshot.types';

// A real Worker Thread, a real exceljs and a real ZIP in every case here. Mocking any
// of them would leave the thing under test - what actually comes out of the thread -
// unexamined.
jest.setTimeout(60_000);

const jobId = '018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62';

/**
 * Bounds are applied to a resolved configuration rather than through the environment,
 * because the schema floors a generation timeout at one second and this suite needs a
 * bound that expires before a thread can start.
 */
function generatorWith(
  mutate: (draft: ReportsConfiguration) => void = () => undefined,
): RoomExportGeneratorService {
  const configuration = createReportsConfiguration(validateEnvironment({}));
  mutate(configuration);
  return new RoomExportGeneratorService(configuration);
}

function snapshotRows(count: number): RoomSnapshotRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: String(9_007_199_254_740_990 + index),
    roomNumber: index % 20 === 0 ? `=A-${index}` : `A-${index}`,
    roomTypeName: 'Deluxe double',
    bedCount: (index % 4) + 1,
    viewCode: index % 3 === 0 ? null : 'CITY',
    basePriceAmount: String(1_000_000 + index),
    currency: 'VND',
    status: 'ACTIVE',
    version: String(index + 1),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    amenities: [{ code: 'AC', name: 'Air conditioning' }],
  }));
}

function generate(
  count: number,
  mutate?: (draft: ReportsConfiguration) => void,
) {
  return generatorWith(mutate).generate({
    jobId,
    attempt: 1,
    rows: toWorkbookRows(snapshotRows(count)),
  });
}

async function codeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return (error as RoomExportProtocolError).code;
  }
  throw new Error('expected generation to fail');
}

/**
 * `@types/node` now parameterises `Buffer` by its backing store, while exceljs's
 * signature predates that. The bytes are the same; only the type parameter differs.
 */
type ExcelJsBuffer = Parameters<ExcelJS.Xlsx['load']>[0];

function asExcelJsBuffer(file: ArrayBuffer): ExcelJsBuffer {
  return Buffer.from(file) as unknown as ExcelJsBuffer;
}

async function readSheet(
  file: ArrayBuffer,
): Promise<{ header: unknown[]; rows: unknown[][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(asExcelJsBuffer(file));
  const values: unknown[][] = [];
  workbook.worksheets[0].eachRow((row) => {
    values.push((row.values as unknown[]).slice(1));
  });
  return { header: values[0] ?? [], rows: values.slice(1) };
}

async function zipEntries(file: ArrayBuffer): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(new Uint8Array(file));
  const entries = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    entries.set(name, await entry.async('string'));
  }
  return entries;
}

describe('workerEntrypoint', () => {
  it('names a file that exists', () => {
    // The thread is loaded by path, not by import, so nothing type-checks this and no
    // static analysis links the worker to its only caller. Renaming or deleting it
    // would compile, lint and pass every test that does not actually start a thread.
    expect(existsSync(workerEntrypoint())).toBe(true);
  });

  it('loads the compiled worker from a compiled caller', () => {
    // Derived from this module's own extension so development and production stay in
    // step. Under `dist` both are `.js`; the build must therefore emit the worker, and
    // a `tsconfig.build.json` exclusion that dropped it would break production while
    // every test here - which runs from `.ts` - kept passing.
    expect(
      workerEntrypoint().endsWith(`room-export.worker${extname(__filename)}`),
    ).toBe(true);
  });
});

describe('RoomExportGeneratorService', () => {
  it('returns one transferred buffer for the attempt that asked', async () => {
    const result = await generate(3);

    expect(result.outcome).toBe('GENERATED');
    expect(result.jobId).toBe(jobId);
    expect(result.attempt).toBe(1);
    expect(result.rowCount).toBe(3);
    expect(result.byteLength).toBe(result.file.byteLength);
    expect(result.file).toBeInstanceOf(ArrayBuffer);
  });

  it('writes a header-only workbook for an empty result', async () => {
    // An export matching nothing is a valid workbook rather than an error: the
    // administrator filtered too narrowly, which is an answer.
    const result = await generate(0);
    const sheet = await readSheet(result.file);

    expect(result.rowCount).toBe(0);
    expect(sheet.header).toEqual([...roomExportWorksheetColumns]);
    expect(sheet.rows).toEqual([]);
  });

  it('writes every accepted column, with escapes and blanks intact', async () => {
    const rows = toWorkbookRows(snapshotRows(2));
    const result = await generatorWith().generate({ jobId, attempt: 1, rows });
    const sheet = await readSheet(result.file);

    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toHaveLength(roomExportWorksheetColumns.length);
    // Row 0 carries `=A-0`, escaped by the mapper. It must arrive as those characters.
    expect(rows[0].roomNumber).toBe("'=A-0");
    expect(sheet.rows[0][1]).toBe("'=A-0");
    // Text stays text and the one genuine number stays a number.
    expect(sheet.rows[0][0]).toBe(rows[0].roomId);
    expect(sheet.rows[0][3]).toBe(rows[0].beds);
    // A blank view is an empty cell, not the word "null".
    expect(sheet.rows[0][4]).toBe('');
  });

  it('produces a package with no formula, macro, external link, or embedded file', async () => {
    const entries = await zipEntries((await generate(5)).file);
    const sheetName = [...entries.keys()].find((name) =>
      name.includes('worksheets/sheet1'),
    );
    const sheetXml = entries.get(sheetName ?? '') ?? '';

    for (const name of entries.keys()) {
      expect(name).not.toMatch(/vbaProject|externalLink|embeddings|oleObject/i);
    }
    // `<f>` is the formula element. Its absence is the assertion the escape exists for.
    expect(sheetXml).not.toMatch(/<f[\s>]/);
    // `t="s"` is a shared-string literal. `t="str"` would be a cached formula result,
    // which is a different claim about a cell that holds no formula.
    expect(sheetXml).toContain('t="s"');
    expect(sheetXml).not.toContain('t="str"');
  });

  it('refuses output past the byte cap instead of transferring it', async () => {
    expect(
      await codeOf(() =>
        generate(500, (draft) => {
          draft.worker.maxFileBytes = 1_024;
        }),
      ),
    ).toBe(roomExportWorkerErrorCodes.outputTooLarge);
  });

  it('classifies a generation that outruns its timeout', async () => {
    expect(
      await codeOf(() =>
        generate(2_000, (draft) => {
          draft.worker.generationTimeoutMs = 1;
        }),
      ),
    ).toBe(roomExportWorkerErrorCodes.timedOut);
  });

  it('classifies a thread that exceeds its heap', async () => {
    // A real out-of-memory termination, not a simulated one. The heap is set far below
    // anything workable rather than just below what this fixture needs: a bound near
    // the requirement makes the test depend on when a garbage collector runs, and a
    // test that passes four times in five is worse than none.
    //
    // What it pins is the classification - an `ERR_WORKER_OUT_OF_MEMORY` reaching the
    // parent as a catchable, retryable failure rather than taking the process down.
    // Where the real threshold sits is measured in the dependency profile check, which
    // drives the accepted fixture past the character cap and requires it to fail.
    expect(
      await codeOf(() =>
        generate(1, (draft) => {
          draft.worker.maxOldGenerationMb = 16;
        }),
      ),
    ).toBe(roomExportWorkerErrorCodes.outOfMemory);
  });
});
