import * as fs from 'fs';
import SSHConfig from 'ssh-config';
import { ConnectionConfig } from './types';
import { defaultSshConfigPath } from '../util/paths';

/**
 * Resolved parameters for a single host alias, computed from ~/.ssh/config with
 * all matching `Host`/`Match` blocks applied. Only the fields we care about are
 * typed; everything else is reachable via the raw record.
 */
export interface ResolvedSshHost {
  hostName: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyJump?: string;
  identityAgent?: string;
  raw: Record<string, string | string[]>;
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function asArray(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** Patterns we never surface as concrete connections in the tree. */
function isConcreteAlias(pattern: string): boolean {
  return !/[*?!]/.test(pattern) && pattern !== '';
}

export class SshConfigReader {
  constructor(private readonly configPath?: string) {}

  private resolvePath(): string {
    return this.configPath && this.configPath.length > 0
      ? this.configPath
      : defaultSshConfigPath();
  }

  private read(): InstanceType<typeof SSHConfig> | undefined {
    const file = this.resolvePath();
    try {
      const text = fs.readFileSync(file, 'utf8');
      return SSHConfig.parse(text);
    } catch (err) {
      // Missing file is the normal case for users who don't use ~/.ssh/config.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      return undefined;
    }
  }

  /** List concrete host aliases (no wildcards) defined in the config. */
  listAliases(): string[] {
    const config = this.read();
    if (!config) {
      return [];
    }
    const aliases = new Set<string>();
    for (const node of config as unknown as Array<Record<string, unknown>>) {
      if (node['param'] !== 'Host') {
        continue;
      }
      const value = node['value'] as string | string[];
      for (const pattern of asArray(value)) {
        if (isConcreteAlias(pattern)) {
          aliases.add(pattern);
        }
      }
    }
    return [...aliases];
  }

  /** Fully resolve a single alias by applying every matching block. */
  compute(alias: string): ResolvedSshHost | undefined {
    const config = this.read();
    if (!config) {
      return undefined;
    }
    const raw = config.compute(alias) as Record<string, string | string[]>;
    const hostName = firstString(raw['HostName']) ?? alias;
    const portStr = firstString(raw['Port']);
    return {
      hostName,
      user: firstString(raw['User']),
      port: portStr ? Number(portStr) : undefined,
      identityFiles: asArray(raw['IdentityFile']),
      proxyJump: firstString(raw['ProxyJump']),
      identityAgent: firstString(raw['IdentityAgent']),
      raw,
    };
  }

  /** Build a normalized ConnectionConfig for every concrete alias. */
  toConnections(): ConnectionConfig[] {
    return this.listAliases().map((alias) => {
      const resolved = this.compute(alias);
      const connection: ConnectionConfig = {
        id: alias,
        host: resolved?.hostName ?? alias,
        port: resolved?.port ?? 22,
        username: resolved?.user ?? '',
        authMethod: 'auto',
        privateKeyPath: resolved?.identityFiles[0],
        proxyJump: resolved?.proxyJump,
        source: 'sshconfig',
      };
      return connection;
    });
  }
}
