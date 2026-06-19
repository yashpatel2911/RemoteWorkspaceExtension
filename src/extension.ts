import * as vscode from 'vscode';
import { Logger } from './util/logger';
import { SecretStore } from './util/secrets';
import { ConnectionStore } from './config/connectionStore';
import { ConnectionManager } from './ssh/ConnectionManager';
import { VscodeAuthPrompts } from './ssh/prompts';
import { RemoteFileSystemProvider } from './fs/RemoteFileSystemProvider';
import { SCHEME } from './fs/uri';
import { RemoteExplorerProvider } from './views/RemoteExplorerProvider';
import { registerCommands } from './commands';
import { RemoteServiceRegistry } from './remoteServices';

export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  logger.info('Activating Remote Workspace');

  const secrets = new SecretStore(context.secrets);
  const store = new ConnectionStore();
  const prompts = new VscodeAuthPrompts(secrets);
  const manager = new ConnectionManager(store, secrets, prompts, logger);

  // Remote filesystem: ssh://<connectionId>/<remote/path>
  const fsProvider = new RemoteFileSystemProvider(manager, logger);
  const fsRegistration = vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, {
    isCaseSensitive: true,
  });

  // Activity-bar tree.
  const explorer = new RemoteExplorerProvider(store, manager, logger);
  const treeView = vscode.window.createTreeView('remoteWorkspaceExplorer', {
    treeDataProvider: explorer,
    showCollapseAll: true,
  });

  // Extension point for future port-forwarding / remote-task services.
  const services = new RemoteServiceRegistry({
    manager,
    logger,
    subscriptions: context.subscriptions,
  });

  const commands = registerCommands({ store, manager, secrets, logger, explorer });

  context.subscriptions.push(
    logger,
    store,
    manager,
    fsProvider,
    fsRegistration,
    explorer,
    treeView,
    services,
    ...commands,
  );

  logger.info('Remote Workspace activated');
}

export function deactivate(): void {
  // All resources are disposed via context.subscriptions.
}
