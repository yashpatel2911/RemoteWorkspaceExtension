import * as vscode from 'vscode';

/**
 * URI scheme for remote resources. A remote file is addressed as:
 *   ssh://<connectionId>/<absolute/remote/path>
 * The authority is the connection id; the path is the POSIX path on the remote.
 */
export const SCHEME = 'ssh';

export interface RemoteLocation {
  id: string;
  path: string;
}

/** Build a remote URI from a connection id and an absolute remote path. */
export function toUri(id: string, remotePath: string): vscode.Uri {
  const path = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
  return vscode.Uri.from({ scheme: SCHEME, authority: id, path });
}

/** Decompose a remote URI back into its connection id and remote path. */
export function fromUri(uri: vscode.Uri): RemoteLocation {
  return {
    id: uri.authority,
    path: uri.path.length > 0 ? uri.path : '/',
  };
}
