import * as vscode from 'vscode';

/**
 * Thin wrapper around an OutputChannel so every module can log consistently.
 * Created once in `activate()` and shared.
 */
export class Logger {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name = 'Remote Workspace') {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(this.format(message, args));
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(this.format(message, args));
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err ? String(err) : '';
    this.channel.error(detail ? `${message} — ${detail}` : message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private format(message: string, args: unknown[]): string {
    if (args.length === 0) {
      return message;
    }
    return `${message} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  }
}
