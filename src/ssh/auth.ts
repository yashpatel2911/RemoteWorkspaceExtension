import * as fs from 'fs/promises';
import type { ConnectConfig } from 'ssh2';
import { ConnectionConfig } from '../config/types';
import { SecretStore } from '../util/secrets';
import { expandTilde } from '../util/paths';

/** Single keyboard-interactive prompt as delivered by ssh2. */
export interface KbPrompt {
  prompt: string;
  echo?: boolean;
}

/** UI hooks for interactively asking the user for missing secrets. */
export interface AuthPrompts {
  promptPassword(connection: ConnectionConfig): Promise<string | undefined>;
  promptPassphrase(connection: ConnectionConfig, keyPath: string): Promise<string | undefined>;
  promptKeyboardInteractive(
    connection: ConnectionConfig,
    name: string,
    instructions: string,
    prompts: KbPrompt[],
  ): Promise<string[]>;
}

/**
 * Resolve the SSH agent socket. `true`/'auto' detects the platform default;
 * a string is used verbatim (including 'pageant' on Windows).
 */
export function resolveAgent(agent: string | boolean | undefined): string | undefined {
  if (agent === false) {
    return undefined;
  }
  if (typeof agent === 'string' && agent.length > 0) {
    return agent;
  }
  // auto-detect (agent === true, 'auto', or undefined when authMethod allows it)
  if (process.platform === 'win32') {
    return 'pageant';
  }
  return process.env.SSH_AUTH_SOCK;
}

/**
 * Translate our ConnectionConfig into the auth-related fields of an ssh2
 * ConnectConfig. Reads key files, pulls secrets from storage, and falls back to
 * interactive prompts. `tryKeyboard` is always enabled so keyboard-interactive
 * / 2FA can complete via the handler attached in SSHConnection.
 */
export async function buildAuthConfig(
  connection: ConnectionConfig,
  secrets: SecretStore,
  prompts: AuthPrompts,
): Promise<ConnectConfig> {
  const method = connection.authMethod;
  const config: ConnectConfig = {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    tryKeyboard: true,
  };

  const wantAgent = method === 'auto' || method === 'agent';
  const wantKey = method === 'auto' || method === 'key';
  const wantPassword = method === 'auto' || method === 'password';

  if (wantAgent) {
    const agent = resolveAgent(connection.agent ?? (method === 'agent'));
    if (agent) {
      config.agent = agent;
    }
  }

  if (wantKey && connection.privateKeyPath) {
    const keyPath = expandTilde(connection.privateKeyPath);
    try {
      const key = await fs.readFile(keyPath);
      config.privateKey = key;
      // Supply a passphrase only if we have/obtain one; unencrypted keys ignore it.
      const stored = await secrets.getPassphrase(connection.id);
      if (stored) {
        config.passphrase = stored;
      } else if (looksEncrypted(key)) {
        const entered = await prompts.promptPassphrase(connection, keyPath);
        if (entered) {
          config.passphrase = entered;
        }
      }
    } catch (err) {
      // A missing key isn't fatal in 'auto' mode — other methods may still work.
      if (method === 'key') {
        throw new Error(`Cannot read private key at ${keyPath}: ${(err as Error).message}`);
      }
    }
  }

  if (wantPassword) {
    const stored = await secrets.getPassword(connection.id);
    if (stored) {
      config.password = stored;
    } else if (method === 'password') {
      const entered = await prompts.promptPassword(connection);
      if (entered) {
        config.password = entered;
      }
    }
  }

  return config;
}

/** Heuristic: PEM keys marked ENCRYPTED, or OpenSSH keys not using 'none' cipher. */
function looksEncrypted(key: Buffer): boolean {
  const head = key.toString('utf8', 0, Math.min(key.length, 4096));
  if (head.includes('ENCRYPTED')) {
    return true;
  }
  // OpenSSH new format: "openssh-key-v1\0" then the kdf/cipher name follows.
  if (head.includes('OPENSSH PRIVATE KEY')) {
    // If the cipher name 'none' is absent early in the blob, assume encrypted.
    return !key.includes(Buffer.from('none'));
  }
  return false;
}
