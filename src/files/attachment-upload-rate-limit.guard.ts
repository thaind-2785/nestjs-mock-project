import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/decorators/current-principal.decorator';
import { AttachmentsService } from './attachments.service';
import { filesErrors } from './files.errors';

/**
 * The upload budget has to be a guard, not a service call.
 *
 * Nest runs guards before interceptors, and the multipart interceptor reads the
 * whole request body into memory before the handler exists. Charging the budget in
 * the handler would bound storage and metadata work while leaving the dominant abuse
 * cost — inbound bandwidth and a buffered body per concurrent request — unbounded.
 *
 * Identity comes from `request.principal`, which the access-token guard sets from a
 * verified token, so the budget cannot be aimed at another uploader or reset from
 * the request payload.
 */
@Injectable()
export class AttachmentUploadRateLimitGuard implements CanActivate {
  public constructor(private readonly attachments: AttachmentsService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const uploaderUserId = request.principal?.userId;
    // An authenticated principal is guaranteed by the global access-token guard.
    // Its absence would mean the route lost its authentication, so refuse rather
    // than fall back to an unbounded upload path.
    if (!uploaderUserId) throw filesErrors.attachmentUploadUnavailable();

    await this.attachments.assertUploadAllowed(uploaderUserId);
    return true;
  }
}
