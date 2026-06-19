import type { Stats } from 'ssh2';
import { SSHConnection } from './SSHConnection';
import * as sftp from './sftp';
import {
  RemoteDirEntry,
  RemoteFs,
  RemoteFsError,
  RemoteFileType,
  RemoteStat,
} from './RemoteFs';

/** Default filesystem: plain SFTP as the login user. Behavior is unchanged. */
export class SftpFs implements RemoteFs {
  constructor(private readonly conn: SSHConnection) {}

  async stat(path: string): Promise<RemoteStat> {
    return this.run(async (s) => toRemoteStat(await sftp.stat(s, path)));
  }

  async readDirectory(path: string): Promise<RemoteDirEntry[]> {
    return this.run(async (s) => {
      const entries = await sftp.readdir(s, path);
      return entries.map((e) => ({ name: e.filename, type: attrType(e.attrs) }));
    });
  }

  async readFile(path: string): Promise<Buffer> {
    return this.run((s) => sftp.readFile(s, path));
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    return this.run((s) => sftp.writeFile(s, path, data));
  }

  async createDirectory(path: string): Promise<void> {
    return this.run((s) => sftp.mkdir(s, path));
  }

  async delete(path: string, options: { recursive: boolean }): Promise<void> {
    return this.run(async (s) => {
      const stats = await sftp.lstat(s, path);
      if (stats.isDirectory()) {
        await (options.recursive ? sftp.rmrf(s, path) : sftp.rmdir(s, path));
      } else {
        await sftp.unlink(s, path);
      }
    });
  }

  async rename(from: string, to: string, options: { overwrite: boolean }): Promise<void> {
    return this.run(async (s) => {
      if (options.overwrite) {
        try {
          const target = await sftp.lstat(s, to);
          await (target.isDirectory() ? sftp.rmrf(s, to) : sftp.unlink(s, to));
        } catch (err) {
          if (mapSftpError(err).code !== 'ENOENT') {
            throw err;
          }
        }
      }
      await sftp.rename(s, from, to);
    });
  }

  async realpath(path: string): Promise<string> {
    return this.run((s) => sftp.realpath(s, path));
  }

  /** Resolve a fresh SFTP session and translate any ssh2 error on failure. */
  private async run<T>(fn: (s: Awaited<ReturnType<SSHConnection['getSftp']>>) => Promise<T>): Promise<T> {
    const session = await this.conn.getSftp();
    try {
      return await fn(session);
    } catch (err) {
      throw mapSftpError(err);
    }
  }
}

function attrType(attrs: Stats): RemoteFileType {
  if (attrs.isDirectory()) {
    return 'directory';
  }
  if (attrs.isSymbolicLink()) {
    return 'symlink';
  }
  return 'file';
}

function toRemoteStat(stats: Stats): RemoteStat {
  return { type: attrType(stats), size: stats.size, mtimeMs: stats.mtime * 1000 };
}

/** Map ssh2/SFTP numeric status codes to a normalized RemoteFsError. */
function mapSftpError(err: unknown): RemoteFsError {
  if (err instanceof RemoteFsError) {
    return err;
  }
  const e = err as { code?: number | string; message?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === 2 || e?.code === 'ENOENT' || /no such file/i.test(msg)) {
    return new RemoteFsError('ENOENT', msg);
  }
  if (e?.code === 3 || e?.code === 'EACCES' || /permission denied/i.test(msg)) {
    return new RemoteFsError('EACCES', msg);
  }
  if (e?.code === 4 && /exist/i.test(msg)) {
    return new RemoteFsError('EEXIST', msg);
  }
  return new RemoteFsError('EUNKNOWN', msg);
}
