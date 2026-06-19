import * as vscode from 'vscode';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig, PseudoTtyOptions, SFTPWrapper } from 'ssh2';
import { ConnectionConfig } from '../config/types';
import { SecretStore } from '../util/secrets';
import { Logger } from '../util/logger';
import { AuthPrompts, buildAuthConfig } from './auth';

export interface SSHConnectionSettings {
  connectTimeoutMs: number;
  keepaliveIntervalMs: number;
}

export interface SSHConnectionDeps {
  config: ConnectionConfig;
  secrets: SecretStore;
  prompts: AuthPrompts;
  logger: Logger;
  settings: SSHConnectionSettings;
}

/**
 * One live ssh2 connection to a single host. Owns lazy connect, a cached SFTP
 * session, shell/exec channels, and proxy forwarding. UI-agnostic: all user
 * interaction goes through the injected `prompts`.
 */
export class SSHConnection {
  private client?: Client;
  private sftpPromise?: Promise<SFTPWrapper>;
  private connecting?: Promise<void>;
  private _connected = false;

  private readonly _onDidChangeState = new vscode.EventEmitter<boolean>();
  readonly onDidChangeState = this._onDidChangeState.event;

  constructor(private readonly deps: SSHConnectionDeps) {}

  get id(): string {
    return this.deps.config.id;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect if not already connected. `extra` lets the manager inject a `sock`
   * stream for ProxyJump. Concurrent callers share one in-flight attempt.
   */
  connect(extra?: ConnectConfig): Promise<void> {
    if (this._connected) {
      return Promise.resolve();
    }
    if (!this.connecting) {
      this.connecting = this.doConnect(extra).finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async doConnect(extra?: ConnectConfig): Promise<void> {
    const { config, secrets, prompts, logger, settings } = this.deps;
    const auth = await buildAuthConfig(config, secrets, prompts);
    const client = new Client();
    this.client = client;

    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => {
        this._connected = true;
        logger.info(`Connected: ${config.id} (${config.username}@${config.host}:${config.port})`);
        this._onDidChangeState.fire(true);
        resolve();
      });

      client.once('error', (err) => {
        logger.error(`Connection error for ${config.id}`, err);
        reject(err);
      });

      client.on('keyboard-interactive', (name, instructions, _lang, kbPrompts, finish) => {
        prompts
          .promptKeyboardInteractive(config, name, instructions, kbPrompts)
          .then((answers) => finish(answers))
          .catch(() => finish([]));
      });

      client.on('close', () => {
        this._connected = false;
        this.sftpPromise = undefined;
        this._onDidChangeState.fire(false);
      });

      client.connect({
        ...auth,
        ...extra,
        readyTimeout: settings.connectTimeoutMs,
        keepaliveInterval: settings.keepaliveIntervalMs,
      });
    });
  }

  /** Cached SFTP session; recreated automatically after a disconnect. */
  getSftp(): Promise<SFTPWrapper> {
    if (!this.client || !this._connected) {
      return Promise.reject(new Error(`Not connected: ${this.deps.config.id}`));
    }
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
        this.client!.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
      });
    }
    return this.sftpPromise;
  }

  /** Open an interactive shell channel (for the integrated terminal). */
  shell(window: PseudoTtyOptions): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      if (!this.client || !this._connected) {
        reject(new Error(`Not connected: ${this.deps.config.id}`));
        return;
      }
      // `term` is carried inside the PseudoTtyOptions window.
      this.client.shell(window, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }

  /** Run a one-off command and resolve with the channel. */
  exec(command: string): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      if (!this.client || !this._connected) {
        reject(new Error(`Not connected: ${this.deps.config.id}`));
        return;
      }
      this.client.exec(command, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }

  /** Open a direct-tcpip channel through this host (used for ProxyJump). */
  forwardOut(dstHost: string, dstPort: number): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      if (!this.client || !this._connected) {
        reject(new Error(`Not connected: ${this.deps.config.id}`));
        return;
      }
      this.client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, stream) =>
        err ? reject(err) : resolve(stream),
      );
    });
  }

  dispose(): void {
    this._connected = false;
    this.sftpPromise = undefined;
    try {
      this.client?.end();
    } catch {
      /* ignore */
    }
    this.client = undefined;
    this._onDidChangeState.fire(false);
    this._onDidChangeState.dispose();
  }
}
