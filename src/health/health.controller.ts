import { Controller, Get, HttpStatus } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApplicationException } from '../common/errors/application.exception';
import { errorMessageKeys } from '../common/errors/error-descriptor';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { CurrentRequestId } from '../common/http/request-id.decorator';
import { ReadinessService } from './readiness.service';

export class LivenessResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ format: 'uuid' })
  requestId!: string;
}

export class ReadinessResponseDto extends LivenessResponseDto {}

export class ServiceNotReadyResponseDto extends ErrorResponseDto {
  @ApiProperty({ example: 'SERVICE_NOT_READY' })
  declare code: string;

  @ApiProperty({ example: { dependencies: ['storage'] } })
  declare details?: Record<string, unknown>;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('live')
  @ApiOperation({ summary: 'Check process liveness' })
  @ApiOkResponse({ type: LivenessResponseDto })
  getLiveness(@CurrentRequestId() requestId: string): LivenessResponseDto {
    return { status: 'ok', requestId };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check required dependency readiness' })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiServiceUnavailableResponse({ type: ServiceNotReadyResponseDto })
  async getReadiness(
    @CurrentRequestId() requestId: string,
  ): Promise<ReadinessResponseDto> {
    const unavailable = await this.readiness.getUnavailableDependencies();
    if (unavailable.length > 0) {
      throw new ApplicationException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'SERVICE_NOT_READY',
        errorMessageKeys.serviceUnavailable,
        { dependencies: unavailable },
      );
    }
    return { status: 'ok', requestId };
  }
}
