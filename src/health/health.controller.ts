import { Controller, Get } from '@nestjs/common';

export interface LivenessResponse {
  status: 'ok';
}

@Controller('health')
export class HealthController {
  @Get('live')
  getLiveness(): LivenessResponse {
    return { status: 'ok' };
  }
}
