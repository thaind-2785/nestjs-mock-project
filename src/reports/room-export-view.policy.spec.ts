import { ExportJobStatus } from './entities/export-job.enums';
import { RoomExportViewStatus } from './room-export-view.enums';
import { toExportJobResponse } from './room-export-view.mapper';
import {
  downloadTtl,
  hasExpired,
  isDownloadable,
  toViewStatus,
} from './room-export-view.policy';
import type { RoomExportJobView } from './room-export-view.types';

const now = new Date('2026-09-17T08:00:00.000Z');

function job(overrides: Partial<RoomExportJobView> = {}): RoomExportJobView {
  return {
    id: '018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62',
    status: ExportJobStatus.Completed,
    filters: { status: 'ACTIVE' },
    objectKey: 'exports/rooms/018f/token.xlsx',
    rowCount: 23,
    fileSizeBytes: 18_462,
    lastErrorCode: null,
    createdAt: new Date('2026-09-17T07:59:00.000Z'),
    startedAt: new Date('2026-09-17T07:59:01.000Z'),
    completedAt: new Date('2026-09-17T07:59:04.000Z'),
    expiresAt: new Date('2026-09-18T07:59:04.000Z'),
    databaseNow: now,
    ...overrides,
  };
}

describe('toViewStatus', () => {
  it('passes a stored status through unchanged', () => {
    for (const status of [
      ExportJobStatus.Queued,
      ExportJobStatus.Processing,
      ExportJobStatus.Failed,
    ]) {
      expect(toViewStatus(job({ status, expiresAt: null }))).toBe(
        status as unknown as RoomExportViewStatus,
      );
    }
  });

  it('reports a lapsed result as expired without anything having stored that', () => {
    expect(toViewStatus(job())).toBe(RoomExportViewStatus.Completed);
    expect(toViewStatus(job({ expiresAt: new Date(now.getTime() - 1) }))).toBe(
      RoomExportViewStatus.Expired,
    );
  });
});

describe('hasExpired', () => {
  it('treats the expiry instant, and the unsignable second before it, as expired', () => {
    // The boundary has to belong to one side. Handing out a URL at exactly the moment
    // cleanup is entitled to delete the object is the wrong side, and so is the last
    // fraction of a second before it: a signed URL's lifetime is whole seconds, so a
    // result with 400 milliseconds left could only be signed for one that outlives it.
    expect(hasExpired(job({ expiresAt: now }))).toBe(true);
    expect(hasExpired(job({ expiresAt: new Date(now.getTime() + 400) }))).toBe(
      true,
    );
    expect(hasExpired(job({ expiresAt: new Date(now.getTime() + 999) }))).toBe(
      true,
    );
    expect(
      hasExpired(job({ expiresAt: new Date(now.getTime() + 1_000) })),
    ).toBe(false);
  });

  it('compares against the database clock, not this process', () => {
    // A row whose expiry is in this host's past but the database's future is not
    // expired. An API host drifting fast must not shorten a result's life.
    const drifted = job({
      expiresAt: new Date('2026-09-17T07:59:00.000Z'),
      databaseNow: new Date('2026-09-17T07:58:00.000Z'),
    });

    expect(hasExpired(drifted)).toBe(false);
  });
});

describe('isDownloadable', () => {
  it('requires completion, a key, an expiry, and time remaining', () => {
    expect(isDownloadable(job())).toBe(true);
    expect(isDownloadable(job({ status: ExportJobStatus.Processing }))).toBe(
      false,
    );
    expect(isDownloadable(job({ objectKey: null }))).toBe(false);
    expect(isDownloadable(job({ expiresAt: null }))).toBe(false);
    expect(isDownloadable(job({ expiresAt: now }))).toBe(false);
    expect(
      isDownloadable(job({ expiresAt: new Date(now.getTime() + 400) })),
    ).toBe(false);
  });
});

describe('downloadTtl', () => {
  it('uses the configured lifetime while the result has longer left', () => {
    expect(downloadTtl(job() as never, 300).seconds).toBe(300);
  });

  it('caps the URL at what remains of the result', () => {
    // Without the cap a job expiring in thirty seconds would still hand out a
    // five-minute URL, and that URL keeps working after the result is gone: a
    // presigned URL is checked by the object store, not by this application.
    const expiring = job({ expiresAt: new Date(now.getTime() + 30_000) });

    const ttl = downloadTtl(expiring as never, 300);

    expect(ttl.seconds).toBe(30);
    expect(ttl.expiresAt.toISOString()).toBe('2026-09-17T08:00:30.000Z');
  });

  it('rounds down, so the URL never outlives the result', () => {
    const expiring = job({ expiresAt: new Date(now.getTime() + 30_900) });

    expect(downloadTtl(expiring as never, 300).seconds).toBe(30);
  });

  it('never rounds a lifetime back up past the result it points at', () => {
    // The shortest URL that can be signed is one second, and the shortest result
    // `isDownloadable` still lets through has exactly one second left. Those are the
    // same number on purpose: a floor of one under a rounded-down remainder would hand
    // out a URL that outlives its result by up to 999 milliseconds - exactly the window
    // in which cleanup is entitled to delete the object.
    const last = job({ expiresAt: new Date(now.getTime() + 1_000) });

    const ttl = downloadTtl(last as never, 300);

    expect(isDownloadable(last)).toBe(true);
    expect(ttl.seconds).toBe(1);
    expect(ttl.expiresAt.getTime()).toBeLessThanOrEqual(
      last.expiresAt?.getTime() ?? 0,
    );
  });
});

describe('toExportJobResponse', () => {
  it('omits result and download fields while the job is queued', () => {
    const response = toExportJobResponse(
      job({
        status: ExportJobStatus.Queued,
        objectKey: null,
        rowCount: null,
        fileSizeBytes: null,
        startedAt: null,
        completedAt: null,
        expiresAt: null,
      }),
    );

    expect(Object.keys(response).sort()).toEqual([
      'createdAt',
      'filters',
      'id',
      'status',
    ]);
  });

  it('carries only a stable code for a failure', () => {
    const response = toExportJobResponse(
      job({
        status: ExportJobStatus.Failed,
        objectKey: null,
        rowCount: null,
        fileSizeBytes: null,
        completedAt: null,
        expiresAt: null,
        lastErrorCode: 'EXPORT_ROW_LIMIT_EXCEEDED',
      }),
    );

    expect(response.errorCode).toBe('EXPORT_ROW_LIMIT_EXCEEDED');
    expect(response.rowCount).toBeUndefined();
    expect(response.download).toBeUndefined();
  });

  it('includes the download only when one was signed', () => {
    const withUrl = toExportJobResponse(job(), {
      url: 'https://storage.invalid/signed',
      expiresAt: new Date('2026-09-17T08:05:00.000Z'),
    });

    expect(withUrl.download).toEqual({
      url: 'https://storage.invalid/signed',
      expiresAt: '2026-09-17T08:05:00.000Z',
    });
    expect(toExportJobResponse(job()).download).toBeUndefined();
  });

  it('keeps an expired result readable but undownloadable', () => {
    // The requester still learns their export existed and when it lapsed, and loses
    // the only field that would still have worked.
    const response = toExportJobResponse(
      job({ expiresAt: new Date(now.getTime() - 1) }),
    );

    expect(response.status).toBe(RoomExportViewStatus.Expired);
    expect(response.rowCount).toBe(23);
    expect(response.expiresAt).toBeDefined();
    expect(response.download).toBeUndefined();
  });

  it('never exposes the object key at any status', () => {
    for (const status of [
      ExportJobStatus.Queued,
      ExportJobStatus.Processing,
      ExportJobStatus.Completed,
      ExportJobStatus.Failed,
    ]) {
      const serialized = JSON.stringify(
        toExportJobResponse(job({ status }), {
          url: 'https://storage.invalid/signed',
          expiresAt: now,
        }),
      );
      expect(serialized).not.toContain('exports/rooms');
    }
  });
});
