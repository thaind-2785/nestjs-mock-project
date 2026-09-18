import { ApiProperty } from '@nestjs/swagger';
import { ExportJobStatus } from '../entities/export-job.enums';

export class CreateRoomExportResponseDto {
  @ApiProperty({ example: '018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62' })
  id!: string;

  @ApiProperty({ enum: ExportJobStatus, example: ExportJobStatus.Queued })
  status!: ExportJobStatus;

  @ApiProperty({ example: '2026-09-17T08:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    example: '/api/v1/admin/exports/018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62',
    description: 'Where the requesting administrator polls this job.',
  })
  pollPath!: string;
}
