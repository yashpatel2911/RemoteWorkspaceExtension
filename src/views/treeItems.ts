import * as vscode from 'vscode';
import { ConnectionConfig } from '../config/types';
import { toUri } from '../fs/uri';

/** A configured connection at the root of the tree. */
export class ConnectionNode extends vscode.TreeItem {
  readonly kind = 'connection' as const;

  constructor(
    readonly config: ConnectionConfig,
    readonly connected: boolean,
    displayName: string,
  ) {
    super(displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `conn:${config.id}`;
    const state = connected ? 'connected' : 'disconnected';
    // e.g. "connection.connected.settings" — menus match prefix and suffix.
    this.contextValue = `connection.${state}.${config.source}`;
    this.description = [
      `${config.username || '?'}@${config.host}`,
      connected ? '● connected' : undefined,
    ]
      .filter(Boolean)
      .join('  ');
    this.tooltip = new vscode.MarkdownString(
      [
        `**${displayName}**`,
        '',
        `- Host: \`${config.host}:${config.port}\``,
        `- User: \`${config.username || '(unset)'}\``,
        `- Auth: \`${config.authMethod}\``,
        config.proxyJump ? `- Jump: \`${config.proxyJump}\`` : '',
        `- Source: \`${config.source}\``,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    this.iconPath = new vscode.ThemeIcon(
      connected ? 'vm-active' : 'vm',
      connected ? new vscode.ThemeColor('charts.green') : undefined,
    );
  }
}

/** A file or directory under a connected host. */
export class RemoteEntryNode extends vscode.TreeItem {
  readonly kind = 'entry' as const;

  constructor(
    readonly connectionId: string,
    readonly remotePath: string,
    readonly isDirectory: boolean,
    name: string,
  ) {
    super(
      name,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.id = `entry:${connectionId}:${remotePath}`;
    this.resourceUri = toUri(connectionId, remotePath);
    this.contextValue = isDirectory ? 'remoteFolder' : 'remoteFile';
    if (!isDirectory) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [this.resourceUri],
      };
    }
  }
}

/** A non-actionable informational row (e.g. an error while browsing). */
export class MessageNode extends vscode.TreeItem {
  readonly kind = 'message' as const;

  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'message';
  }
}

export type TreeNode = ConnectionNode | RemoteEntryNode | MessageNode;
