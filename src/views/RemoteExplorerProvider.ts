import * as vscode from 'vscode';
import { ConnectionStore } from '../config/connectionStore';
import { ConnectionManager } from '../ssh/ConnectionManager';
import { Logger } from '../util/logger';
import { remoteJoin } from '../util/paths';
import { ConnectionNode, FolderNode, MessageNode, RemoteEntryNode, TreeNode } from './treeItems';

const CONNECTION_MIME = 'application/vnd.remoteworkspace.connection';

/**
 * Tree for the Remote Workspace activity-bar view. Root level lists every
 * known connection; expanding a connection connects (if needed) and browses the
 * remote filesystem starting at its default folder (or the login home).
 */
export class RemoteExplorerProvider
  implements
    vscode.TreeDataProvider<TreeNode>,
    vscode.TreeDragAndDropController<TreeNode>,
    vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dragMimeTypes = [CONNECTION_MIME];
  readonly dropMimeTypes = [CONNECTION_MIME];

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
      return this.folderLevel('');
    }

    if (element.kind === 'folder') {
      return this.folderLevel(element.path);
    }

    if (element.kind === 'connection') {
      return this.browseConnectionRoot(element);
    }

    if (element.kind === 'entry' && element.isDirectory) {
      return this.browseDirectory(element.connectionId, element.remotePath);
    }

    return [];
  }

  /** Subfolders then connections that live directly under `parent` ('' = root). */
  private folderLevel(parent: string): TreeNode[] {
    const folders = this.store.childFolders(parent).map((p) => new FolderNode(p));
    const connections = this.store
      .list()
      .filter((c) => (c.folder ?? '') === parent)
      .map(
        (c) =>
          new ConnectionNode(c, this.manager.isConnected(c.id), this.store.displayName(c)),
      );
    return [...folders, ...connections];
  }

  // ---- Drag and drop: move connections between folders ----------------------

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const ids = source
      .filter((n): n is ConnectionNode => n.kind === 'connection')
      .map((n) => n.config.id);
    if (ids.length > 0) {
      dataTransfer.set(CONNECTION_MIME, new vscode.DataTransferItem(ids));
    }
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(CONNECTION_MIME);
    if (!item) {
      return;
    }
    const ids = item.value as string[];
    let folder: string | undefined;
    if (target?.kind === 'folder') {
      folder = target.path;
    } else if (target?.kind === 'connection') {
      folder = target.config.folder; // drop onto a connection => same folder
    } else {
      folder = undefined; // empty space => root
    }
    for (const id of ids) {
      await this.store.setConnectionFolder(id, folder);
    }
    this.refresh();
  }

  private async browseConnectionRoot(node: ConnectionNode): Promise<TreeNode[]> {
    try {
      const fs = await this.manager.getFs(node.config.id);
      const base =
        node.config.defaultFolder && node.config.defaultFolder.length > 0
          ? node.config.defaultFolder
          : await fs.realpath('.');
      return this.browseDirectory(node.config.id, base);
    } catch (err) {
      this.logger.error(`Failed to browse ${node.config.id}`, err);
      return [new MessageNode(`Connect failed: ${(err as Error).message}`, 'error')];
    }
  }

  private async browseDirectory(connectionId: string, dir: string): Promise<TreeNode[]> {
    try {
      const fs = await this.manager.getFs(connectionId);
      const entries = await fs.readDirectory(dir);
      return entries
        .filter((e) => e.name !== '.' && e.name !== '..')
        .map(
          (e) =>
            new RemoteEntryNode(
              connectionId,
              remoteJoin(dir, e.name),
              e.type === 'directory',
              e.name,
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
