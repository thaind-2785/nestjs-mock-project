import { Injectable, Logger } from '@nestjs/common';
import { DatabaseConnectionService } from '../database/database-connection.service';
import { redriveIsolation } from './notification-redrive.constants';
import { NotificationRedriveRepository } from './notification-redrive.repository';
import type {
  RedriveRequest,
  RedriveResult,
} from './notification-redrive.types';

/**
 * The operator-facing half of a redrive: one transaction, and one audit line.
 *
 * The line is emitted for a refusal as well as for a change. An operator who decides
 * an event must go out again has made a judgment about a message a guest will read,
 * and "the CLI said no" is the record that explains why the guest did not receive it.
 */
@Injectable()
export class NotificationRedriveService {
  private readonly logger = new Logger(NotificationRedriveService.name);

  constructor(
    private readonly database: DatabaseConnectionService,
    private readonly redrives: NotificationRedriveRepository,
  ) {}

  async redrive(request: RedriveRequest): Promise<RedriveResult> {
    const dataSource = await this.database.ensureInitialized();
    const result = await dataSource.transaction(redriveIsolation, (manager) =>
      this.redrives.redrive(manager, request),
    );
    this.logger.log({
      event: 'notification_redrive_requested',
      outboxEventId: result.outboxEventId,
      applied: result.applied,
      code: result.code,
      observedEventStatus: result.observedEventStatus,
      deliveriesReset: result.deliveriesReset,
      // The justification is operator-written free text: it can name a guest, quote a
      // provider response, or paste a ticket body. Its length proves one was given
      // and required no redaction policy to log.
      reasonLength: request.reason.length,
    });
    return result;
  }
}
