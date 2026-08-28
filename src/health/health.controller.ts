import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentRequestId } from '../common/http/request-id.decorator';

export class LivenessResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ format: 'uuid' })
  requestId!: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get('live')
  @ApiOperation({ summary: 'Check process liveness' })
  @ApiOkResponse({ type: LivenessResponseDto })
  getLiveness(@CurrentRequestId() requestId: string): LivenessResponseDto {
    return { status: 'ok', requestId };
  }
}
