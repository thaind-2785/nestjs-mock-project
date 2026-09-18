import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RoomExportViewStatus } from '../room-export-view.enums';

export class ExportJobDownloadDto {
  @ApiProperty({
    example: 'https://storage.example.invalid/signed-request',
    description:
      'A bearer secret. Short lived, never logged, and capped by the result lifetime.',
  })
  url!: string;

  @ApiProperty({ example: '2026-09-17T08:05:00.000Z' })
  expiresAt!: string;
}

export class ExportJobResponseDto {
  @ApiProperty({ example: '018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62' })
  id!: string;

  @ApiProperty({ enum: RoomExportViewStatus })
  status!: RoomExportViewStatus;

  @ApiProperty({
    description: 'The normalized filter snapshot this job was created with.',
    additionalProperties: true,
    type: 'object',
  })
  filters!: Record<string, unknown>;

  @ApiProperty({ example: '2026-09-17T08:00:00.000Z' })
  createdAt!: string;

  @ApiPropertyOptional({ example: '2026-09-17T08:00:01.000Z' })
  startedAt?: string;

  @ApiPropertyOptional({ example: '2026-09-17T08:00:04.000Z' })
  completedAt?: string;

  @ApiPropertyOptional({
    example: '2026-09-18T08:00:04.000Z',
    description: 'When the result stops being downloadable.',
  })
  expiresAt?: string;

  @ApiPropertyOptional({ example: 23 })
  rowCount?: number;

  @ApiPropertyOptional({ example: 18462 })
  fileSizeBytes?: number;

  @ApiPropertyOptional({
    example: 'EXPORT_ROW_LIMIT_EXCEEDED',
    description: 'A stable classification. Never provider text or a stack.',
  })
  errorCode?: string;

  @ApiPropertyOptional({ type: ExportJobDownloadDto })
  download?: ExportJobDownloadDto;
}
