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
          folder: this.normalizeFolderPath(meta?.folder ?? '') || undefined,
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
      folder: this.normalizeFolderPath(stored.folder ?? '') || undefined,
      source: 'settings',
    };
  }

  // ---- Folder management ----------------------------------------------------

  /** Trim, drop empty segments, collapse slashes: " a / b/ " -> "a/b". */
  private normalizeFolderPath(path: string): string {
    return path
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join('/');
  }

  /** "a/b/c" -> ["a", "a/b", "a/b/c"]. */
  private ancestorsOf(path: string): string[] {
    const parts = path.split('/');
    const out: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
      out.push(parts.slice(0, i).join('/'));
    }
    return out;
  }

  /** Every folder path: the `folders` setting + connection folders + ancestors. */
  listFolders(): string[] {
    const set = new Set<string>();
    const add = (raw: string | undefined) => {
      const p = this.normalizeFolderPath(raw ?? '');
      if (p) {
        this.ancestorsOf(p).forEach((a) => set.add(a));
      }
    };
    this.config.get<string[]>('folders', []).forEach(add);
    this.list().forEach((c) => add(c.folder));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** Direct child folder paths of `parent` ('' = root level). */
  childFolders(parent: string): string[] {
    const prefix = parent ? `${parent}/` : '';
    return this.listFolders().filter((f) => {
      if (!f.startsWith(prefix)) {
        return false;
      }
      const rest = f.slice(prefix.length);
      return rest.length > 0 && !rest.includes('/');
    });
  }

  async addFolder(path: string): Promise<void> {
    const p = this.normalizeFolderPath(path);
    if (!p) {
      return;
    }
    const set = this.currentFolderSet();
    this.ancestorsOf(p).forEach((a) => set.add(a));
    await this.writeFolders(set);
  }

  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const oldP = this.normalizeFolderPath(oldPath);
    const newP = this.normalizeFolderPath(newPath);
    if (!oldP || !newP || oldP === newP) {
      return;
    }
    const reprefix = (f: string | undefined): string | undefined => {
      if (!f) {
        return f;
      }
      const n = this.normalizeFolderPath(f);
      if (n === oldP) {
        return newP;
      }
      if (n.startsWith(`${oldP}/`)) {
        return `${newP}${n.slice(oldP.length)}`;
      }
      return f;
    };

    const folders = this.currentFolderSet();
    const renamed = new Set<string>();
    for (const f of folders) {
      renamed.add(reprefix(f) ?? f);
    }
    this.ancestorsOf(newP).forEach((a) => renamed.add(a));
    await this.writeFolders(renamed);
    await this.remapFolders(reprefix);
  }

  /** Remove `path` and its descendants; reparent affected connections one level up. */
  async deleteFolder(path: string): Promise<void> {
    const p = this.normalizeFolderPath(path);
    if (!p) {
      return;
    }
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const isUnder = (f: string | undefined): boolean => {
      if (!f) {
        return false;
      }
      const n = this.normalizeFolderPath(f);
      return n === p || n.startsWith(`${p}/`);
    };

    const folders = [...this.currentFolderSet()].filter((f) => !isUnder(f));
    await this.writeFolders(new Set(folders));
    await this.remapFolders((f) => (isUnder(f) ? parent || undefined : f));
  }

  /** Assign a connection to a folder (undefined = root). Works for both sources. */
  async setConnectionFolder(id: string, folder: string | undefined): Promise<void> {
    const target = folder ? this.normalizeFolderPath(folder) || undefined : undefined;
    const conn = this.get(id);
    if (!conn) {
      return;
    }
    if (conn.source === 'settings') {
      const conns = this.config.get<StoredConnection[]>('connections', []);
      const next = conns.map((c) => (c.id === id ? { ...c, folder: target } : c));
      await this.config.update('connections', next, vscode.ConfigurationTarget.Global);
    } else {
      const meta = this.config.get<Record<string, HostMetadata>>('hostMetadata', {});
      const next = { ...meta, [id]: { ...(meta[id] ?? {}), folder: target } };
      await this.config.update('hostMetadata', next, vscode.ConfigurationTarget.Global);
    }
  }

  private currentFolderSet(): Set<string> {
    const set = new Set<string>();
    for (const f of this.config.get<string[]>('folders', [])) {
      const p = this.normalizeFolderPath(f);
      if (p) {
        set.add(p);
      }
    }
    return set;
  }

  private async writeFolders(set: Set<string>): Promise<void> {
    await this.config.update(
      'folders',
      [...set].sort((a, b) => a.localeCompare(b)),
      vscode.ConfigurationTarget.Global,
    );
  }

  /** Apply a folder-path transform to every connection and host-metadata entry. */
  private async remapFolders(map: (folder: string | undefined) => string | undefined): Promise<void> {
    const conns = this.config.get<StoredConnection[]>('connections', []);
    let connChanged = false;
    const nextConns = conns.map((c) => {
      const nf = map(c.folder);
      if (nf !== c.folder) {
        connChanged = true;
        return { ...c, folder: nf };
      }
      return c;
    });
    if (connChanged) {
      await this.config.update('connections', nextConns, vscode.ConfigurationTarget.Global);
    }

    const meta = this.config.get<Record<string, HostMetadata>>('hostMetadata', {});
    let metaChanged = false;
    const nextMeta: Record<string, HostMetadata> = {};
    for (const [id, m] of Object.entries(meta)) {
      const nf = map(m.folder);
      if (nf !== m.folder) {
        metaChanged = true;
        nextMeta[id] = { ...m, folder: nf };
      } else {
        nextMeta[id] = m;
      }
    }
    if (metaChanged) {
      await this.config.update('hostMetadata', nextMeta, vscode.ConfigurationTarget.Global);
    }
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
