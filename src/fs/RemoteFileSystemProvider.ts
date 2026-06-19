import * as vscode from 'vscode';
import { ConnectionManager } from '../ssh/ConnectionManager';
import { Logger } from '../util/logger';
import { fromUri } from './uri';
import * as sftp from '../ssh/sftp';

/** SFTP status code for "no such file". */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;
const SFTP_FAILURE = 4;

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return (
    e?.code === SFTP_NO_SUCH_FILE ||
    e?.code === 'ENOENT' ||
    /no such file/i.test(e?.message ?? '')
  );
}

function toFsError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
  const e = err as { code?: number | string; message?: string };
  if (isNotFound(err)) {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (e?.code === SFTP_PERMISSION_DENIED || e?.code === 'EACCES') {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  if (e?.code === SFTP_FAILURE && /exist/i.test(e?.message ?? '')) {
    return vscode.FileSystemError.FileExists(uri);
  }
  return vscode.FileSystemError.Unavailable(`${e?.message ?? String(err)} (${uri.toString()})`);
}

/**
 * Implements VS Code's FileSystemProvider over SFTP. Each method resolves the
 * connection from the URI authority, grabs a (cached) SFTP session, and
 * performs a live operation — no local mirror. Saves are write-through with
 * remote mtime change detection.
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
      const session = await this.manager.getSftp(id);
      const stats = await sftp.stat(session, path);
      return this.toFileStat(stats);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { id, path } = fromUri(uri);
    try {
      const session = await this.manager.getSftp(id);
      const entries = await sftp.readdir(session, path);
      return entries.map((entry) => {
        const a = entry.attrs;
        let type: vscode.FileType;
        if (a.isDirectory()) {
          type = vscode.FileType.Directory;
        } else if (a.isSymbolicLink()) {
          type = vscode.FileType.File | vscode.FileType.SymbolicLink;
        } else {
          type = vscode.FileType.File;
        }
        return [entry.filename, type] as [string, vscode.FileType];
      });
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { id, path } = fromUri(uri);
    try {
      const session = await this.manager.getSftp(id);
      await sftp.mkdir(session, path);
      this.fire(uri, vscode.FileChangeType.Created);
    } catch (err) {
      throw toFsError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { id, path } = fromUri(uri);
    try {
      const session = await this.manager.getSftp(id);
      const stats = await sftp.stat(session, path);
      this.knownMtimes.set(uri.toString(), stats.mtime * 1000);
      return await sftp.readFile(session, path);
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
      const session = await this.manager.getSftp(id);

      let existingMtimeMs: number | undefined;
      try {
        const stats = await sftp.stat(session, path);
        existingMtimeMs = stats.mtime * 1000;
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

      if (exists && (await this.isExternallyChanged(uri, existingMtimeMs!))) {
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

      await sftp.writeFile(session, path, Buffer.from(content));
      const after = await sftp.stat(session, path);
      this.knownMtimes.set(uri.toString(), after.mtime * 1000);
      this.fire(uri, exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created);
    } catch (err) {
      if (err instanceof vscode.FileSystemError) {
        throw err;
      }
      throw toFsError(err, uri);
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { id, path } = fromUri(uri);
    try {
      const session = await this.manager.getSftp(id);
      const stats = await sftp.lstat(session, path);
      if (stats.isDirectory()) {
        if (options.recursive) {
          await sftp.rmrf(session, path);
        } else {
          await sftp.rmdir(session, path);
        }
      } else {
        await sftp.unlink(session, path);
      }
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
      const session = await this.manager.getSftp(from.id);
      if (options.overwrite) {
        try {
          const target = await sftp.lstat(session, to.path);
          if (target.isDirectory()) {
            await sftp.rmrf(session, to.path);
          } else {
            await sftp.unlink(session, to.path);
          }
        } catch (err) {
          if (!isNotFound(err)) {
            throw err;
          }
        }
      }
      await sftp.rename(session, from.path, to.path);
      this.knownMtimes.delete(oldUri.toString());
      this.fire(oldUri, vscode.FileChangeType.Deleted);
      this.fire(newUri, vscode.FileChangeType.Created);
    } catch (err) {
      throw toFsError(err, newUri);
    }
  }

  private async isExternallyChanged(uri: vscode.Uri, currentMtimeMs: number): Promise<boolean> {
    const known = this.knownMtimes.get(uri.toString());
    return known !== undefined && currentMtimeMs > known;
  }

  private toFileStat(stats: import('ssh2').Stats): vscode.FileStat {
    let type: vscode.FileType;
    if (stats.isDirectory()) {
      type = vscode.FileType.Directory;
    } else if (stats.isSymbolicLink()) {
      type = vscode.FileType.SymbolicLink;
    } else {
      type = vscode.FileType.File;
    }
    const mtimeMs = stats.mtime * 1000;
    return {
      type,
      ctime: mtimeMs,
      mtime: mtimeMs,
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
