import * as vscode from 'vscode';
import { ConnectionStore } from '../config/connectionStore';
import { ConnectionManager } from '../ssh/ConnectionManager';
import { Logger } from '../util/logger';
import * as sftp from '../ssh/sftp';
import { remoteJoin } from '../util/paths';
import { ConnectionNode, MessageNode, RemoteEntryNode, TreeNode } from './treeItems';

/**
 * Tree for the Remote Workspace activity-bar view. Root level lists every
 * known connection; expanding a connection connects (if needed) and browses the
 * remote filesystem starting at its default folder (or the login home).
 */
export class RemoteExplorerProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConnectionStore,
    private readonly manager: ConnectionManager,
    private readonly logger: Logger,
  ) {
    this.subscriptions.push(
      this.store.onDidChange(() => this.refresh()),
      this.manager.onDidChangeState(() => this.refresh()),
    );
  }

  refresh(node?: TreeNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      return this.store
        .list()
        .map(
          (config) =>
            new ConnectionNode(
              config,
              this.manager.isConnected(config.id),
              this.store.displayName(config),
            ),
        );
    }

    if (element.kind === 'connection') {
      return this.browseConnectionRoot(element);
    }

    if (element.kind === 'entry' && element.isDirectory) {
      return this.browseDirectory(element.connectionId, element.remotePath);
    }

    return [];
  }

  private async browseConnectionRoot(node: ConnectionNode): Promise<TreeNode[]> {
    try {
      await this.manager.connect(node.config.id);
      const session = await this.manager.getSftp(node.config.id);
      const base =
        node.config.defaultFolder && node.config.defaultFolder.length > 0
          ? node.config.defaultFolder
          : await sftp.realpath(session, '.');
      return this.browseDirectory(node.config.id, base);
    } catch (err) {
      this.logger.error(`Failed to browse ${node.config.id}`, err);
      return [new MessageNode(`Connect failed: ${(err as Error).message}`, 'error')];
    }
  }

  private async browseDirectory(connectionId: string, dir: string): Promise<TreeNode[]> {
    try {
      const session = await this.manager.getSftp(connectionId);
      const entries = await sftp.readdir(session, dir);
      return entries
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map(
          (e) =>
            new RemoteEntryNode(
              connectionId,
              remoteJoin(dir, e.filename),
              e.attrs.isDirectory(),
              e.filename,
            ),
        )
        .sort(byFolderThenName);
    } catch (err) {
      this.logger.error(`Failed to list ${connectionId}:${dir}`, err);
      return [new MessageNode(`Cannot list ${dir}: ${(err as Error).message}`, 'error')];
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const sub of this.subscriptions) {
      sub.dispose();
    }
  }
}

function byFolderThenName(a: RemoteEntryNode, b: RemoteEntryNode): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1;
  }
  return String(a.label).localeCompare(String(b.label));
}
