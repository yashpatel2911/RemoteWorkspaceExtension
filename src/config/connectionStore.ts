import * as vscode from 'vscode';
import { ConnectionConfig, HostMetadata, StoredConnection } from './types';
import { SshConfigReader } from './sshConfig';

const CONFIG_SECTION = 'remoteWorkspace';

/**
 * Single source of truth for the set of known connections. Combines two
 * inputs:
 *   1. User-defined connections in `remoteWorkspace.connections` (editable).
 *   2. Hosts parsed from ~/.ssh/config (read-only, optionally augmented with
 *      `remoteWorkspace.hostMetadata`).
 * Settings-defined connections win on id collisions.
 */
export class ConnectionStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        this._onDidChange.fire();
      }
    });
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  /** Merged, normalized list of every connection, sorted by display name. */
  list(): ConnectionConfig[] {
    const byId = new Map<string, ConnectionConfig>();

    if (this.config.get<boolean>('showSshConfigHosts', true)) {
      const reader = new SshConfigReader(this.config.get<string>('sshConfigPath'));
      const metadata = this.config.get<Record<string, HostMetadata>>('hostMetadata', {});
      for (const conn of safe(() => reader.toConnections(), [])) {
        const meta = metadata[conn.id];
        byId.set(conn.id, {
          ...conn,
          label: meta?.label ?? conn.label,
          defaultFolder: meta?.defaultFolder ?? conn.defaultFolder,
        });
      }
    }

    for (const stored of this.config.get<StoredConnection[]>('connections', [])) {
      byId.set(stored.id, this.normalize(stored));
    }

    return [...byId.values()].sort((a, b) =>
      this.displayName(a).localeCompare(this.displayName(b)),
    );
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  displayName(c: ConnectionConfig): string {
    return c.label && c.label.length > 0 ? c.label : c.id;
  }

  /** Create or replace a settings-defined connection. */
  async upsert(connection: StoredConnection): Promise<void> {
    const all = this.config.get<StoredConnection[]>('connections', []);
    const next = all.filter((c) => c.id !== connection.id);
    next.push(connection);
    await this.config.update('connections', next, vscode.ConfigurationTarget.Global);
  }

  /** Remove a settings-defined connection. Returns false if it wasn't ours. */
  async remove(id: string): Promise<boolean> {
    const all = this.config.get<StoredConnection[]>('connections', []);
    if (!all.some((c) => c.id === id)) {
      return false;
    }
    await this.config.update(
      'connections',
      all.filter((c) => c.id !== id),
      vscode.ConfigurationTarget.Global,
    );
    return true;
  }

  private normalize(stored: StoredConnection): ConnectionConfig {
    return {
      id: stored.id,
      label: stored.label,
      host: stored.host,
      port: stored.port ?? 22,
      username: stored.username,
      authMethod: stored.authMethod ?? 'auto',
      privateKeyPath: stored.privateKeyPath,
      agent: stored.agent,
      proxyJump: stored.proxyJump,
      defaultFolder: stored.defaultFolder,
      source: 'settings',
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChange.dispose();
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
