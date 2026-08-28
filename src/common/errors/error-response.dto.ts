import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'VALIDATION_FAILED' })
  code!: string;

  @ApiProperty({ example: 'Request validation failed.' })
  message!: string;

  @ApiPropertyOptional({
    additionalProperties: true,
    description: 'Machine-readable, sanitized error context.',
    type: 'object',
  })
  details?: Record<string, unknown>;

  @ApiProperty({ format: 'uuid' })
  requestId!: string;
}
