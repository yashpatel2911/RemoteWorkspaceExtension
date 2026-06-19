/**
 * Where a connection definition came from. `settings` connections are fully
 * editable through the webview; `sshconfig` connections are read-only mirrors
 * of ~/.ssh/config (only their attached metadata can be edited).
 */
export type ConnectionSource = 'settings' | 'sshconfig';

export type AuthMethod = 'auto' | 'agent' | 'key' | 'password';

/**
 * The normalized shape every part of the extension consumes. Secrets
 * (passwords, key passphrases) are intentionally absent — they are resolved at
 * connect-time from VS Code SecretStorage.
 */
export interface ConnectionConfig {
  /** Unique id; doubles as the URI authority: ssh://<id>/path. */
  id: string;
  /** Human-friendly name shown in the tree. Falls back to `id`. */
  label?: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  /** true = auto-detect agent; string = explicit socket path / 'pageant'. */
  agent?: string | boolean;
  /** Single jump host "[user@]host[:port]" or the id of another connection. */
  proxyJump?: string;
  /** Remote absolute path to open by default. Empty = login home directory. */
  defaultFolder?: string;
  source: ConnectionSource;
}

/** Raw user object as stored in `remoteWorkspace.connections`. */
export interface StoredConnection {
  id: string;
  label?: string;
  host: string;
  port?: number;
  username: string;
  authMethod?: AuthMethod;
  privateKeyPath?: string;
  agent?: string | boolean;
  proxyJump?: string;
  defaultFolder?: string;
}

export interface HostMetadata {
  label?: string;
  defaultFolder?: string;
}
