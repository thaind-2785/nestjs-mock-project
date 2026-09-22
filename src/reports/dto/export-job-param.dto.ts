import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ExportJobParamDto {
  @ApiProperty({
    format: 'uuid',
    example: '018f6f4e-7d5a-7b71-9f45-5e9a13cfcb62',
  })
  @IsUUID()
  jobId!: string;
}
