import * as vscode from 'vscode';
import { ConnectionManager } from '../ssh/ConnectionManager';
import { Logger } from '../util/logger';
import { fromUri } from './uri';
import { RemoteFsError, RemoteStat } from '../ssh/RemoteFs';

function isNotFound(err: unknown): boolean {
  return err instanceof RemoteFsError && err.code === 'ENOENT';
}

function toFsError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
  if (err instanceof vscode.FileSystemError) {
    return err;
  }
  if (err instanceof RemoteFsError) {
    switch (err.code) {
      case 'ENOENT':
        return vscode.FileSystemError.FileNotFound(uri);
      case 'EACCES':
        return vscode.FileSystemError.NoPermissions(uri);
      case 'EEXIST':
        return vscode.FileSystemError.FileExists(uri);
      default:
        return vscode.FileSystemError.Unavailable(`${err.message} (${uri.toString()})`);
    }
  }
  return vscode.FileSystemError.Unavailable(`${String(err)} (${uri.toString()})`);
}

/**
 * Implements VS Code's FileSystemProvider over a RemoteFs (plain SFTP, or
 * sudo-elevated shell commands when the connection opts in). Each method
 * resolves the connection from the URI authority and performs a live operation —
 * no local mirror. Saves are write-through with remote mtime change detection.
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  /** mtime (ms) observed when a file was last read/written, for conflict detection. */
  private readonly knownMtimes = new Map<string, number>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly logger: Logger,
  ) {}

  // SFTP has no inotify; live watching is a future enhancement (poll/SSH inotify).
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { id, path } = fromUri(uri);
    try {
      const fs = await this.manager.getFs(id);
      return this.toFileStat(await fs.stat(path));
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { id, path } = fromUri(uri);
    try {
      const fs = await this.manager.getFs(id);
      const entries = await fs.readDirectory(path);
      return entries.map((entry) => {
        let type: vscode.FileType;
        if (entry.type === 'directory') {
          type = vscode.FileType.Directory;
        } else if (entry.type === 'symlink') {
          type = vscode.FileType.File | vscode.FileType.SymbolicLink;
        } else {
          type = vscode.FileType.File;
        }
        return [entry.name, type] as [string, vscode.FileType];
      });
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { id, path } = fromUri(uri);
    try {
      const fs = await this.manager.getFs(id);
      await fs.createDirectory(path);
      this.fire(uri, vscode.FileChangeType.Created);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { id, path } = fromUri(uri);
    try {
      const fs = await this.manager.getFs(id);
      const stats = await fs.stat(path);
      this.knownMtimes.set(uri.toString(), stats.mtimeMs);
      return await fs.readFile(path);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const { id, path } = fromUri(uri);
    try {
      const fs = await this.manager.getFs(id);

      let existingMtimeMs: number | undefined;
      try {
        existingMtimeMs = (await fs.stat(path)).mtimeMs;
      } catch (err) {
        if (!isNotFound(err)) {
          throw err;
        }
      }
      const exists = existingMtimeMs !== undefined;

      if (!exists && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (exists && options.create && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }

      if (exists && this.isExternallyChanged(uri, existingMtimeMs!)) {
        this.logger.warn(`Remote file changed since open: ${uri.toString()}`);
        const choice = await vscode.window.showWarningMessage(
          `"${path}" has changed on the remote since you opened it. Overwrite the remote version with your local changes?`,
          { modal: true },
          'Overwrite',
        );
        if (choice !== 'Overwrite') {
          throw vscode.FileSystemError.Unavailable('Save cancelled to avoid overwriting remote changes.');
        }
      }

      await fs.writeFile(path, Buffer.from(content));
      this.knownMtimes.set(uri.toString(), (await fs.stat(path)).mtimeMs);
      this.fire(uri, exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { id, path } = fromUri(uri);
    try {
      const fs = await this.manager.getFs(id);
      await fs.delete(path, options);
      this.knownMtimes.delete(uri.toString());
      this.fire(uri, vscode.FileChangeType.Deleted);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    const from = fromUri(oldUri);
    const to = fromUri(newUri);
    if (from.id !== to.id) {
      throw vscode.FileSystemError.Unavailable('Moving across connections is not supported.');
    }
    try {
      const fs = await this.manager.getFs(from.id);
      await fs.rename(from.path, to.path, options);
      this.knownMtimes.delete(oldUri.toString());
      this.fire(oldUri, vscode.FileChangeType.Deleted);
      this.fire(newUri, vscode.FileChangeType.Created);
    } catch (err) {
      throw toFsError(err, newUri);
    }
  }

  private isExternallyChanged(uri: vscode.Uri, currentMtimeMs: number): boolean {
    const known = this.knownMtimes.get(uri.toString());
    return known !== undefined && currentMtimeMs > known;
  }

  private toFileStat(stats: RemoteStat): vscode.FileStat {
    let type: vscode.FileType;
    if (stats.type === 'directory') {
      type = vscode.FileType.Directory;
    } else if (stats.type === 'symlink') {
      type = vscode.FileType.SymbolicLink;
    } else {
      type = vscode.FileType.File;
    }
    return {
      type,
      ctime: stats.mtimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  }

  private fire(uri: vscode.Uri, type: vscode.FileChangeType): void {
    this._onDidChangeFile.fire([{ type, uri }]);
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
    this.knownMtimes.clear();
  }
}
