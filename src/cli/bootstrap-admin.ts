import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import {
  AdminBootstrapError,
  AdminBootstrapService,
} from '../users/admin-bootstrap.service';

interface Arguments {
  userId: string;
  email: string;
  reason: string;
}

async function main(): Promise<void> {
  const input = parseArguments(process.argv.slice(2));
  const application = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  try {
    const result = await application.get(AdminBootstrapService).promote(input);
    process.stdout.write(`bootstrap-admin:${result}\n`);
  } finally {
    await application.close();
  }
}

function parseArguments(argumentsList: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (
      !key?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new AdminBootstrapError('INVALID_CLI_ARGUMENTS');
    }
    values.set(key.slice(2), value);
  }
  const userId = values.get('user-id');
  const email = values.get('email');
  const reason = values.get('reason');
  if (!userId || !email || !reason || values.size !== 3) {
    throw new AdminBootstrapError('INVALID_CLI_ARGUMENTS');
  }
  return { userId, email, reason };
}

void main().catch((error: unknown) => {
  const code =
    error instanceof AdminBootstrapError
      ? error.code
      : 'BOOTSTRAP_ADMIN_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
