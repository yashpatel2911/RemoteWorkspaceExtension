import * as vscode from 'vscode';
import type { ClientChannel } from 'ssh2';
import { ConnectionManager } from '../ssh/ConnectionManager';
import { ConnectionConfig } from '../config/types';
import { Logger } from '../util/logger';

/**
 * A VS Code pseudoterminal backed by an ssh2 interactive shell. Input typed in
 * the panel is forwarded to the remote shell; remote output is streamed back.
 */
class RemotePty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private channel?: ClientChannel;
  private pendingInput: string[] = [];
  private dimensions?: vscode.TerminalDimensions;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly config: ConnectionConfig,
    private readonly logger: Logger,
  ) {}

  async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
    this.dimensions = initialDimensions;
    this.writeEmitter.fire(`\x1b[2mConnecting to ${this.config.host}...\x1b[0m\r\n`);
    try {
      const conn = await this.manager.connect(this.config.id);
      const channel = await conn.shell({
        rows: initialDimensions?.rows ?? 24,
        cols: initialDimensions?.columns ?? 80,
        term: 'xterm-256color',
      });
      this.channel = channel;

      channel.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString('utf8')));
      channel.stderr?.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString('utf8')));
      channel.on('close', () => {
        this.writeEmitter.fire('\r\n\x1b[2m[remote shell closed]\x1b[0m\r\n');
        this.closeEmitter.fire(0);
      });

      // Flush any keystrokes typed before the shell was ready.
      for (const chunk of this.pendingInput) {
        channel.write(chunk);
      }
      this.pendingInput = [];
      if (this.dimensions) {
        this.setDimensions(this.dimensions);
      }
    } catch (err) {
      this.logger.error(`Terminal connect failed for ${this.config.id}`, err);
      this.writeEmitter.fire(`\r\n\x1b[31mConnection failed: ${(err as Error).message}\x1b[0m\r\n`);
      this.closeEmitter.fire(1);
    }
  }

  handleInput(data: string): void {
    if (this.channel) {
      this.channel.write(data);
    } else {
      this.pendingInput.push(data);
    }
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dimensions = dimensions;
    this.channel?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
  }

  close(): void {
    try {
      this.channel?.end();
    } catch {
      /* ignore */
    }
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

/** Create and reveal a remote terminal for the given connection. */
export function openRemoteTerminal(
  manager: ConnectionManager,
  config: ConnectionConfig,
  logger: Logger,
): vscode.Terminal {
  const pty = new RemotePty(manager, config, logger);
  const terminal = vscode.window.createTerminal({
    name: config.label && config.label.length > 0 ? config.label : `SSH: ${config.host}`,
    pty,
    iconPath: new vscode.ThemeIcon('remote'),
  });
  terminal.show();
  return terminal;
}
