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
import { Public } from '../auth/decorators/public.decorator';
import { CurrentRequestId } from '../common/http/request-id.decorator';
import { ReadinessService } from './readiness.service';
import { currentRevision } from './revision.constants';

export class LivenessResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  /** The commit this build was made from, or `unknown` outside a built image. */
  @ApiProperty({ example: '9f1c2b7e4a8d5c3f0b6e2a1d7c4f8b3e5a9d0c2f' })
  revision!: string;
}

export class ReadinessResponseDto extends LivenessResponseDto {}

export class ServiceNotReadyResponseDto extends ErrorResponseDto {
  @ApiProperty({ example: 'SERVICE_NOT_READY' })
  declare code: string;

  @ApiProperty({ example: { dependencies: ['storage'] } })
  declare details?: Record<string, unknown>;
}

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('live')
  @ApiOperation({ summary: 'Check process liveness' })
  @ApiOkResponse({ type: LivenessResponseDto })
  getLiveness(@CurrentRequestId() requestId: string): LivenessResponseDto {
    return { status: 'ok', requestId, revision: currentRevision() };
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
    return { status: 'ok', requestId, revision: currentRevision() };
  }
}
