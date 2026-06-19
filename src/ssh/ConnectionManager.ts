import * as vscode from 'vscode';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';
import { ConnectionConfig } from '../config/types';
import { ConnectionStore } from '../config/connectionStore';
import { SecretStore } from '../util/secrets';
import { Logger } from '../util/logger';
import { AuthPrompts } from './auth';
import { SSHConnection, SSHConnectionSettings } from './SSHConnection';

export interface ConnectionStateEvent {
  id: string;
  connected: boolean;
}

/**
 * Owns the pool of live SSHConnections, keyed by connection id. Handles lazy
 * creation, ProxyJump orchestration, and relays per-connection state changes as
 * a single stream the tree/UI can subscribe to.
 */
export class ConnectionManager implements vscode.Disposable {
  private readonly connections = new Map<string, SSHConnection>();

  private readonly _onDidChangeState = new vscode.EventEmitter<ConnectionStateEvent>();
  readonly onDidChangeState = this._onDidChangeState.event;

  constructor(
    private readonly store: ConnectionStore,
    private readonly secrets: SecretStore,
    private readonly prompts: AuthPrompts,
    private readonly logger: Logger,
  ) {}

  /** Already-created connection, if any (does not create or connect). */
  peek(id: string): SSHConnection | undefined {
    return this.connections.get(id);
  }

  isConnected(id: string): boolean {
    return this.connections.get(id)?.connected ?? false;
  }

  /** Get an existing connection or build one from the store definition. */
  getOrCreate(id: string): SSHConnection {
    const existing = this.connections.get(id);
    if (existing) {
      return existing;
    }
    const config = this.store.get(id);
    if (!config) {
      throw new Error(`Unknown connection: ${id}`);
    }
    return this.createFor(config);
  }

  /** Ensure a connection is established (handling ProxyJump) and return it. */
  async connect(id: string): Promise<SSHConnection> {
    const config = this.store.get(id);
    if (!config) {
      throw new Error(`Unknown connection: ${id}`);
    }
    const conn = this.getOrCreate(id);
    await this.establish(conn, config);
    return conn;
  }

  disconnect(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.dispose();
      this.connections.delete(id);
    }
  }

  /** Connected SFTP session for a connection, connecting first if needed. */
  async getSftp(id: string): Promise<SFTPWrapper> {
    const conn = this.isConnected(id) ? this.getOrCreate(id) : await this.connect(id);
    return conn.getSftp();
  }

  /** Connect a throwaway connection to validate config, then tear it down. */
  async testConnection(config: ConnectionConfig): Promise<void> {
    const conn = this.createFor(config, /* ephemeral */ true);
    try {
      await this.establish(conn, config);
    } finally {
      conn.dispose();
    }
  }

  private createFor(config: ConnectionConfig, ephemeral = false): SSHConnection {
    const settings = this.readSettings();
    const conn = new SSHConnection({
      config,
      secrets: this.secrets,
      prompts: this.prompts,
      logger: this.logger,
      settings,
    });
    if (!ephemeral) {
      conn.onDidChangeState((connected) => {
        this._onDidChangeState.fire({ id: config.id, connected });
      });
      this.connections.set(config.id, conn);
    }
    return conn;
  }

  /** Resolve ProxyJump (if any) into a `sock` and connect. */
  private async establish(conn: SSHConnection, config: ConnectionConfig): Promise<void> {
    let extra: ConnectConfig | undefined;
    if (config.proxyJump) {
      this.logger.info(`Routing ${config.id} through jump host ${config.proxyJump}`);
      const jumpConfig = this.resolveJump(config.proxyJump, config);
      const jump = this.getOrCreateJump(jumpConfig);
      await this.establish(jump, jumpConfig); // recurse: supports chained jumps
      const sock = await jump.forwardOut(config.host, config.port);
      extra = { sock };
    }
    await conn.connect(extra);
  }

  private getOrCreateJump(config: ConnectionConfig): SSHConnection {
    const existing = this.connections.get(config.id);
    return existing ?? this.createFor(config);
  }

  /**
   * A ProxyJump spec is either the id of another configured connection or an
   * inline `[user@]host[:port]`. Inline hosts inherit the target's agent/user.
   */
  private resolveJump(spec: string, target: ConnectionConfig): ConnectionConfig {
    const existing = this.store.get(spec);
    if (existing) {
      return existing;
    }
    let user = target.username;
    let host = spec;
    let port = 22;
    const at = host.lastIndexOf('@');
    if (at >= 0) {
      user = host.slice(0, at);
      host = host.slice(at + 1);
    }
    const colon = host.lastIndexOf(':');
    if (colon >= 0) {
      const maybePort = Number(host.slice(colon + 1));
      if (!Number.isNaN(maybePort)) {
        port = maybePort;
        host = host.slice(0, colon);
      }
    }
    return {
      id: `jump:${spec}`,
      label: `Jump ${spec}`,
      host,
      port,
      username: user,
      authMethod: 'auto',
      agent: target.agent,
      source: 'settings',
    };
  }

  private readSettings(): SSHConnectionSettings {
    const cfg = vscode.workspace.getConfiguration('remoteWorkspace');
    return {
      connectTimeoutMs: cfg.get<number>('connectTimeoutMs', 20000),
      keepaliveIntervalMs: cfg.get<number>('keepaliveIntervalMs', 15000),
    };
  }

  dispose(): void {
    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();
    this._onDidChangeState.dispose();
  }
}
