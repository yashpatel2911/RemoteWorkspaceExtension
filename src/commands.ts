import * as vscode from 'vscode';
import { ConnectionStore } from './config/connectionStore';
import { ConnectionManager } from './ssh/ConnectionManager';
import { SecretStore } from './util/secrets';
import { Logger } from './util/logger';
import { RemoteExplorerProvider } from './views/RemoteExplorerProvider';
import { ConnectionNode, FolderNode, RemoteEntryNode } from './views/treeItems';
import { ConnectionEditorPanel } from './webview/ConnectionEditorPanel';
import { openRemoteTerminal } from './terminal/RemoteTerminal';
import { ConnectionConfig } from './config/types';
import { toUri } from './fs/uri';
import * as sftp from './ssh/sftp';

export interface CommandDeps {
  store: ConnectionStore;
  manager: ConnectionManager;
  secrets: SecretStore;
  logger: Logger;
  explorer: RemoteExplorerProvider;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { store, manager, secrets, logger, explorer } = deps;

  const register = (command: string, handler: (...args: unknown[]) => unknown) =>
    vscode.commands.registerCommand(command, handler);

  return [
    register('remoteWorkspace.refresh', () => explorer.refresh()),

    register('remoteWorkspace.addConnection', () =>
      ConnectionEditorPanel.createOrShow({ store, manager, secrets, logger }),
    ),

    register('remoteWorkspace.editConnection', async (node) => {
      const config = await resolveConnection(node, store, 'Select a connection to edit');
      if (!config) {
        return;
      }
      if (config.source !== 'settings') {
        vscode.window.showInformationMessage(
          `"${store.displayName(config)}" comes from ~/.ssh/config and can't be edited here. Edit the file directly, or add a settings-based connection.`,
        );
        return;
      }
      ConnectionEditorPanel.createOrShow({ store, manager, secrets, logger }, config);
    }),

    register('remoteWorkspace.deleteConnection', async (node) => {
      const config = await resolveConnection(node, store, 'Select a connection to delete');
      if (!config) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete connection "${store.displayName(config)}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') {
        return;
      }
      const removed = await store.remove(config.id);
      if (!removed) {
        vscode.window.showWarningMessage('Only settings-based connections can be deleted here.');
        return;
      }
      manager.disconnect(config.id);
      await secrets.clear(config.id);
    }),

    register('remoteWorkspace.connect', async (node) => {
      const config = await resolveConnection(node, store, 'Select a connection');
      if (!config) {
        return;
      }
      await withProgress(`Connecting to ${store.displayName(config)}…`, async () => {
        await manager.connect(config.id);
      });
    }),

    register('remoteWorkspace.disconnect', async (node) => {
      const config = await resolveConnection(node, store, 'Select a connection to disconnect');
      if (config) {
        manager.disconnect(config.id);
      }
    }),

    register('remoteWorkspace.openTerminal', async (node) => {
      const config = await resolveConnection(node, store, 'Open terminal for…');
      if (config) {
        openRemoteTerminal(manager, config, logger);
      }
    }),

    register('remoteWorkspace.testConnection', async (node) => {
      const config = await resolveConnection(node, store, 'Test which connection?');
      if (!config) {
        return;
      }
      await withProgress(`Testing ${store.displayName(config)}…`, async () => {
        try {
          await manager.testConnection(config);
          vscode.window.showInformationMessage(`✓ ${store.displayName(config)} is reachable.`);
        } catch (err) {
          vscode.window.showErrorMessage(`✗ ${(err as Error).message}`);
        }
      });
    }),

    register('remoteWorkspace.openFolder', (node) => openFolder(node, deps, false)),
    register('remoteWorkspace.openFolderInNewWindow', (node) => openFolder(node, deps, true)),

    register('remoteWorkspace.addFolder', async (node) => {
      const parent = node instanceof FolderNode ? node.path : '';
      const name = await vscode.window.showInputBox({
        title: parent ? `New folder under "${parent}"` : 'New folder',
        prompt: 'Folder name',
        ignoreFocusOut: true,
        validateInput: (v) =>
          v.includes('/') ? 'Folder name cannot contain "/".' : undefined,
      });
      const trimmed = name?.trim();
      if (!trimmed) {
        return;
      }
      await store.addFolder(parent ? `${parent}/${trimmed}` : trimmed);
    }),

    register('remoteWorkspace.renameFolder', async (node) => {
      if (!(node instanceof FolderNode)) {
        return;
      }
      const current = leafName(node.path);
      const name = await vscode.window.showInputBox({
        title: `Rename folder "${node.path}"`,
        value: current,
        ignoreFocusOut: true,
        validateInput: (v) =>
          v.includes('/') ? 'Folder name cannot contain "/".' : undefined,
      });
      const trimmed = name?.trim();
      if (!trimmed || trimmed === current) {
        return;
      }
      const parent = node.path.includes('/')
        ? node.path.slice(0, node.path.lastIndexOf('/'))
        : '';
      await store.renameFolder(node.path, parent ? `${parent}/${trimmed}` : trimmed);
    }),

    register('remoteWorkspace.deleteFolder', async (node) => {
      if (!(node instanceof FolderNode)) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete folder "${node.path}"? Connections inside move up one level — they are not deleted.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') {
        return;
      }
      await store.deleteFolder(node.path);
    }),

    register('remoteWorkspace.moveToFolder', async (node) => {
      const config = await resolveConnection(node, store, 'Move which connection?');
      if (!config) {
        return;
      }
      const target = await pickFolder(store, `Move "${store.displayName(config)}" to…`);
      if (target === undefined) {
        return;
      }
      await store.setConnectionFolder(config.id, target.folder);
    }),
  ];
}

function leafName(path: string): string {
  return path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
}

/** Pick a destination folder. Returns undefined on cancel, or { folder } (folder undefined = root). */
async function pickFolder(
  store: ConnectionStore,
  placeholder: string,
): Promise<{ folder: string | undefined } | undefined> {
  type Item = vscode.QuickPickItem & { folder?: string; action?: 'new' };
  const items: Item[] = [
    { label: '$(home) Root (no folder)', folder: undefined },
    ...store.listFolders().map((f): Item => ({ label: `$(folder) ${f}`, folder: f })),
    { label: '$(add) New folder…', action: 'new' },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: placeholder });
  if (!picked) {
    return undefined;
  }
  if (picked.action === 'new') {
    const name = await vscode.window.showInputBox({
      title: 'New folder',
      prompt: 'Folder path (use "/" to nest, e.g. Work/Prod)',
      ignoreFocusOut: true,
    });
    const trimmed = name?.trim();
    if (!trimmed) {
      return undefined;
    }
    await store.addFolder(trimmed);
    return { folder: trimmed };
  }
  return { folder: picked.folder };
}

async function openFolder(node: unknown, deps: CommandDeps, newWindow: boolean): Promise<void> {
  const { store, manager } = deps;

  let connectionId: string;
  let folder: string | undefined;

  if (node instanceof RemoteEntryNode && node.isDirectory) {
    connectionId = node.connectionId;
    folder = node.remotePath;
  } else {
    const config =
      node instanceof ConnectionNode
        ? node.config
        : await pickConnection(store, 'Open remote folder from…');
    if (!config) {
      return;
    }
    connectionId = config.id;
    folder = await resolveFolder(config, manager);
    if (folder === undefined) {
      return;
    }
  }

  const uri = toUri(connectionId, folder);
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: newWindow });
}

/** Determine which folder to open: configured default, or prompt from home. */
async function resolveFolder(
  config: ConnectionConfig,
  manager: ConnectionManager,
): Promise<string | undefined> {
  if (config.defaultFolder && config.defaultFolder.length > 0) {
    return config.defaultFolder;
  }
  let home = '/';
  try {
    await manager.connect(config.id);
    const session = await manager.getSftp(config.id);
    home = await sftp.realpath(session, '.');
  } catch (err) {
    vscode.window.showErrorMessage(`Could not connect: ${(err as Error).message}`);
    return undefined;
  }
  return vscode.window.showInputBox({
    title: `Open folder on ${config.host}`,
    prompt: 'Remote absolute path to open',
    value: home,
    ignoreFocusOut: true,
  });
}

/** Resolve the target connection from a tree node, or prompt when absent. */
async function resolveConnection(
  node: unknown,
  store: ConnectionStore,
  placeholder: string,
): Promise<ConnectionConfig | undefined> {
  if (node instanceof ConnectionNode) {
    return node.config;
  }
  if (node instanceof RemoteEntryNode) {
    return store.get(node.connectionId);
  }
  return pickConnection(store, placeholder);
}

async function pickConnection(
  store: ConnectionStore,
  placeholder: string,
): Promise<ConnectionConfig | undefined> {
  const connections = store.list();
  if (connections.length === 0) {
    vscode.window.showInformationMessage('No connections configured yet. Add one first.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((c) => ({
      label: store.displayName(c),
      description: `${c.username || '?'}@${c.host}:${c.port}`,
      detail: c.source === 'sshconfig' ? 'from ~/.ssh/config' : undefined,
      config: c,
    })),
    { placeHolder: placeholder, matchOnDescription: true },
  );
  return picked?.config;
}

function withProgress(title: string, task: () => Promise<void>): Thenable<void> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task,
  );
}
