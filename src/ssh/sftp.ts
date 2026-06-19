import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';

/**
 * Promise wrappers around the callback-based ssh2 SFTPWrapper. Kept as free
 * functions so callers pass a freshly-resolved SFTP session each time (sessions
 * are cached/recreated by SSHConnection).
 */

export function stat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

export function lstat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

export function readdir(sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
  });
}

export function readFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data as Buffer)));
  });
}

export function writeFile(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (err) => (err ? reject(err) : resolve()));
  });
}

export function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
  });
}

export function rmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => (err ? reject(err) : resolve()));
  });
}

export function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
  });
}

export function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
  });
}

export function realpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (err, absPath) => (err ? reject(err) : resolve(absPath)));
  });
}

/** Recursively delete a directory tree over SFTP. */
export async function rmrf(sftp: SFTPWrapper, path: string): Promise<void> {
  const entries = await readdir(sftp, path);
  for (const entry of entries) {
    const child = `${path}/${entry.filename}`;
    if (entry.attrs.isDirectory()) {
      await rmrf(sftp, child);
    } else {
      await unlink(sftp, child);
    }
  }
  await rmdir(sftp, path);
}
