/**
 * Transport-agnostic remote filesystem. RemoteFileSystemProvider and the tree
 * talk to this interface instead of SFTP directly, so a connection can be backed
 * by plain SFTP (login user) or by sudo-elevated shell commands (another user).
 */

export type RemoteFileType = 'file' | 'directory' | 'symlink';

export interface RemoteStat {
  type: RemoteFileType;
  size: number;
  /** Modification time in milliseconds since the epoch. */
  mtimeMs: number;
}

export interface RemoteDirEntry {
  name: string;
  type: RemoteFileType;
}

/** Normalized error codes so the provider maps uniformly to FileSystemError. */
export type RemoteFsErrorCode = 'ENOENT' | 'EACCES' | 'EEXIST' | 'EUNKNOWN';

export class RemoteFsError extends Error {
  constructor(
    readonly code: RemoteFsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteFsError';
  }
}

export interface RemoteFs {
  stat(path: string): Promise<RemoteStat>;
  readDirectory(path: string): Promise<RemoteDirEntry[]>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  createDirectory(path: string): Promise<void>;
  delete(path: string, options: { recursive: boolean }): Promise<void>;
  rename(from: string, to: string, options: { overwrite: boolean }): Promise<void>;
  /** Resolve a path; '.' resolves to the (effective) user's home directory. */
  realpath(path: string): Promise<string>;
}
