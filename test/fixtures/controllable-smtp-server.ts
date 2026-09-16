import { createServer, Server, Socket } from 'node:net';
import { once } from 'node:events';

export interface AcceptedMessage {
  from: string;
  to: string[];
  body: string;
}

export interface ControllableSmtpServerOptions {
  /**
   * Called after the message body is complete and before the acceptance is written to
   * the socket. Whatever this does happens while the client is still waiting, which is
   * what makes "the provider accepted, and then..." a deterministic moment rather than
   * a race.
   */
  onBeforeAccept?: (message: AcceptedMessage) => Promise<void> | void;
  /** Called once the `250` has been flushed - the client now believes it succeeded. */
  onAfterAccept?: (message: AcceptedMessage) => Promise<void> | void;
  /**
   * Delay before each acceptance. A backlog that drains at a known rate is what lets a
   * test kill a worker midway through it rather than hoping to win a race.
   */
  acceptDelayMs?: number;
}

/**
 * The smallest SMTP server that nodemailer will talk to, with hooks around the single
 * moment that matters.
 *
 * Mailpit cannot do this: it accepts when it accepts, and a test that wants to kill a
 * worker in the window between the provider's acceptance and the database write has no
 * way to know when that window opened. Owning the server turns that window into a
 * callback.
 *
 * It deliberately advertises no STARTTLS and no AUTH, so the client stays on the plain
 * path the Mailpit transport uses.
 */
export class ControllableSmtpServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  readonly accepted: AcceptedMessage[] = [];

  constructor(private readonly options: ControllableSmtpServerOptions = {}) {
    this.server = createServer((socket) => this.handle(socket));
  }

  async listen(): Promise<number> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('SMTP fixture did not bind a TCP port');
    }
    return address.port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.close();
    await once(this.server, 'close');
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));

    let buffer = '';
    let inData = false;
    let body = '';
    let from = '';
    const to: string[] = [];

    socket.write('220 fixture ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const terminator = buffer.indexOf('\r\n.\r\n');
          if (terminator === -1) return;
          body += buffer.slice(0, terminator);
          buffer = buffer.slice(terminator + 5);
          inData = false;
          const message: AcceptedMessage = { from, to: [...to], body };
          this.accepted.push(message);
          void this.acceptMessage(socket, message);
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const command = line.toUpperCase();
        if (command.startsWith('EHLO') || command.startsWith('HELO')) {
          socket.write('250-fixture\r\n250 HELP\r\n');
        } else if (command.startsWith('MAIL FROM')) {
          from = extractAddress(line);
          socket.write('250 OK\r\n');
        } else if (command.startsWith('RCPT TO')) {
          to.push(extractAddress(line));
          socket.write('250 OK\r\n');
        } else if (command.startsWith('DATA')) {
          inData = true;
          body = '';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command.startsWith('QUIT')) {
          socket.write('221 Bye\r\n');
          socket.end();
          return;
        } else if (command.startsWith('RSET') || command.startsWith('NOOP')) {
          socket.write('250 OK\r\n');
        } else {
          socket.write('502 Command not implemented\r\n');
        }
      }
    });
  }

  private async acceptMessage(
    socket: Socket,
    message: AcceptedMessage,
  ): Promise<void> {
    if (this.options.acceptDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.acceptDelayMs),
      );
    }
    await this.options.onBeforeAccept?.(message);
    socket.write('250 OK: queued as fixture\r\n');
    await this.options.onAfterAccept?.(message);
  }
}

function extractAddress(line: string): string {
  const opened = line.indexOf('<');
  const closed = line.indexOf('>');
  return opened === -1 || closed === -1
    ? line.slice(line.indexOf(':') + 1).trim()
    : line.slice(opened + 1, closed);
}
