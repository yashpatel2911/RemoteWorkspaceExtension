import * as os from 'os';
import * as path from 'path';

/** Expand a leading ~ or ~/ to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Default OpenSSH config path. */
export function defaultSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

/**
 * Join POSIX-style remote paths (the remote is always Linux, regardless of the
 * local OS, so never use path.join which would use backslashes on Windows).
 */
export function remoteJoin(...parts: string[]): string {
  return path.posix.join(...parts);
}

/** Last path segment of a remote (POSIX) path. */
export function remoteBasename(p: string): string {
  return path.posix.basename(p) || p;
}

/** Parent of a remote (POSIX) path. */
export function remoteDirname(p: string): string {
  return path.posix.dirname(p);
}
