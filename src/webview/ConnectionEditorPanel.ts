import * as vscode from 'vscode';
import { ConnectionStore } from '../config/connectionStore';
import { ConnectionManager } from '../ssh/ConnectionManager';
import { SecretStore } from '../util/secrets';
import { Logger } from '../util/logger';
import { AuthMethod, ConnectionConfig, StoredConnection } from '../config/types';

interface FormData {
  id: string;
  label: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath: string;
  useAgent: boolean;
  proxyJump: string;
  defaultFolder: string;
  password: string;
  passphrase: string;
  sudo: boolean;
  sudoUser: string;
  sudoPassword: string;
}

/**
 * Webview form to create or edit a settings-defined connection, with a
 * "Test connection" button. Secrets entered here are written to SecretStorage,
 * never to settings.json.
 */
export class ConnectionEditorPanel {
  private static readonly viewType = 'remoteWorkspace.connectionEditor';
  private static readonly openPanels = new Map<string, ConnectionEditorPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static createOrShow(
    deps: {
      store: ConnectionStore;
      manager: ConnectionManager;
      secrets: SecretStore;
      logger: Logger;
    },
    existing?: ConnectionConfig,
  ): void {
    const key = existing?.id ?? '__new__';
    const opened = ConnectionEditorPanel.openPanels.get(key);
    if (opened) {
      opened.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ConnectionEditorPanel.viewType,
      existing ? `Edit: ${existing.label ?? existing.id}` : 'New Connection',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ConnectionEditorPanel.openPanels.set(
      key,
      new ConnectionEditorPanel(panel, key, deps, existing),
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly key: string,
    private readonly deps: {
      store: ConnectionStore;
      manager: ConnectionManager;
      secrets: SecretStore;
      logger: Logger;
    },
    existing?: ConnectionConfig,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render(existing);

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.onMessage(msg),
      undefined,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  private async onMessage(msg: { type: string; data?: FormData }): Promise<void> {
    if (msg.type === 'cancel') {
      this.panel.dispose();
      return;
    }
    if (!msg.data) {
      return;
    }
    const form = msg.data;

    if (msg.type === 'test') {
      try {
        await this.deps.manager.testConnection(this.toConfig(form));
        await this.saveSecrets(form);
        this.post({ type: 'testResult', ok: true, message: 'Connection succeeded.' });
      } catch (err) {
        this.post({ type: 'testResult', ok: false, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === 'save') {
      const validationError = this.validate(form);
      if (validationError) {
        this.post({ type: 'testResult', ok: false, message: validationError });
        return;
      }
      await this.deps.store.upsert(this.toStored(form));
      await this.saveSecrets(form);
      this.deps.logger.info(`Saved connection ${form.id}`);
      vscode.window.showInformationMessage(`Saved connection "${form.label || form.id}".`);
      this.panel.dispose();
    }
  }

  private validate(form: FormData): string | undefined {
    if (!form.id.trim()) {
      return 'Id is required.';
    }
    if (!/^[A-Za-z0-9._-]+$/.test(form.id.trim())) {
      return 'Id may only contain letters, numbers, dot, dash and underscore.';
    }
    if (!form.host.trim()) {
      return 'Host is required.';
    }
    if (!form.username.trim()) {
      return 'Username is required.';
    }
    return undefined;
  }

  private toStored(form: FormData): StoredConnection {
    return {
      id: form.id.trim(),
      label: form.label.trim() || undefined,
      host: form.host.trim(),
      port: Number(form.port) || 22,
      username: form.username.trim(),
      authMethod: form.authMethod,
      privateKeyPath: form.privateKeyPath.trim() || undefined,
      agent: form.useAgent ? true : undefined,
      proxyJump: form.proxyJump.trim() || undefined,
      defaultFolder: form.defaultFolder.trim() || undefined,
      sudo: form.sudo ? true : undefined,
      sudoUser: form.sudo ? form.sudoUser.trim() || 'root' : undefined,
    };
  }

  private toConfig(form: FormData): ConnectionConfig {
    const stored = this.toStored(form);
    return {
      ...stored,
      port: stored.port ?? 22,
      authMethod: stored.authMethod ?? 'auto',
      source: 'settings',
    };
  }

  private async saveSecrets(form: FormData): Promise<void> {
    const id = form.id.trim();
    if (form.password) {
      await this.deps.secrets.setPassword(id, form.password);
    }
    if (form.passphrase) {
      await this.deps.secrets.setPassphrase(id, form.passphrase);
    }
    if (form.sudoPassword) {
      await this.deps.secrets.setSudoPassword(id, form.sudoPassword);
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private render(existing?: ConnectionConfig): string {
    const nonce = getNonce();
    const v = (s: string | undefined) => escapeHtml(s ?? '');
    const method = existing?.authMethod ?? 'auto';
    const selected = (m: AuthMethod) => (method === m ? 'selected' : '');
    const idReadonly = existing ? 'readonly' : '';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    padding: 16px 20px; }
  h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 4px; }
  p.sub { color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
  .grid { display: grid; grid-template-columns: 160px 1fr; gap: 10px 14px; align-items: center;
    max-width: 640px; }
  label { color: var(--vscode-foreground); }
  .hint { grid-column: 2; color: var(--vscode-descriptionForeground); font-size: 0.85em;
    margin-top: -6px; }
  input, select { width: 100%; box-sizing: border-box; padding: 5px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; }
  .row-check { grid-column: 2; display: flex; align-items: center; gap: 8px; }
  .row-check input { width: auto; }
  .section-sep { grid-column: 1 / -1; margin-top: 12px; padding-top: 12px; font-weight: 600;
    border-top: 1px solid var(--vscode-input-border, #8886); }
  .hidden { display: none !important; }
  .actions { display: flex; gap: 8px; margin-top: 22px; max-width: 640px; }
  button { padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #status { margin-top: 14px; max-width: 640px; min-height: 1.2em; }
  #status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  #status.err { color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <h1>${existing ? 'Edit connection' : 'New connection'}</h1>
  <p class="sub">Secrets are stored securely in VS Code SecretStorage — never in settings.json.</p>
  <form id="form" class="grid">
    <label for="id">Id</label>
    <input id="id" value="${v(existing?.id)}" ${idReadonly} placeholder="my-server" />
    <div class="hint">Unique. Used in the URI as ssh://&lt;id&gt;/path.</div>

    <label for="label">Label</label>
    <input id="label" value="${v(existing?.label)}" placeholder="Production box" />

    <label for="host">Host</label>
    <input id="host" value="${v(existing?.host)}" placeholder="example.com or 10.0.0.5" />

    <label for="port">Port</label>
    <input id="port" type="number" value="${v(String(existing?.port ?? 22))}" />

    <label for="username">Username</label>
    <input id="username" value="${v(existing?.username)}" placeholder="root" />

    <label for="authMethod">Auth method</label>
    <select id="authMethod">
      <option value="auto" ${selected('auto')}>Auto (agent → key → password)</option>
      <option value="agent" ${selected('agent')}>SSH agent</option>
      <option value="key" ${selected('key')}>Private key</option>
      <option value="password" ${selected('password')}>Password</option>
    </select>

    <label for="privateKeyPath">Private key path</label>
    <input id="privateKeyPath" value="${v(existing?.privateKeyPath)}" placeholder="~/.ssh/id_ed25519" />

    <label>Agent</label>
    <div class="row-check">
      <input id="useAgent" type="checkbox" ${existing?.agent ? 'checked' : ''} />
      <span>Use SSH agent (SSH_AUTH_SOCK / Pageant)</span>
    </div>

    <label for="proxyJump">Jump host</label>
    <input id="proxyJump" value="${v(existing?.proxyJump)}" placeholder="[user@]bastion[:port] or a connection id" />

    <label for="defaultFolder">Default folder</label>
    <input id="defaultFolder" value="${v(existing?.defaultFolder)}" placeholder="/home/user/project (blank = home)" />

    <label for="password">Password</label>
    <input id="password" type="password" placeholder="${existing ? '•••••• (leave blank to keep)' : 'optional'}" />

    <label for="passphrase">Key passphrase</label>
    <input id="passphrase" type="password" placeholder="${existing ? '•••••• (leave blank to keep)' : 'optional'}" />

    <div class="section-sep">Run as another user (sudo)</div>
    <label>Enable</label>
    <div class="row-check">
      <input id="sudo" type="checkbox" ${existing?.sudo ? 'checked' : ''} />
      <span>Open the workspace as another user via sudo (the terminal stays as the login user)</span>
    </div>

    <label for="sudoUser" class="sudo-row">Sudo user</label>
    <input id="sudoUser" class="sudo-row" value="${v(existing?.sudoUser ?? 'root')}" placeholder="root" />

    <label for="sudoPassword" class="sudo-row">Sudo password</label>
    <input id="sudoPassword" class="sudo-row" type="password" placeholder="${existing ? '•••••• (leave blank to keep)' : "your login user's sudo password (optional)"}" />
    <div class="hint sudo-row">Your <em>login user's</em> sudo password — not the target user's. Leave blank for passwordless sudo or to be prompted at connect.</div>
  </form>

  <div class="actions">
    <button id="save">Save</button>
    <button id="test" class="secondary">Test connection</button>
    <button id="cancel" class="secondary">Cancel</button>
  </div>
  <div id="status"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const status = $('status');

    function collect() {
      return {
        id: $('id').value,
        label: $('label').value,
        host: $('host').value,
        port: $('port').value,
        username: $('username').value,
        authMethod: $('authMethod').value,
        privateKeyPath: $('privateKeyPath').value,
        useAgent: $('useAgent').checked,
        proxyJump: $('proxyJump').value,
        defaultFolder: $('defaultFolder').value,
        password: $('password').value,
        passphrase: $('passphrase').value,
        sudo: $('sudo').checked,
        sudoUser: $('sudoUser').value,
        sudoPassword: $('sudoPassword').value,
      };
    }

    function syncSudo() {
      const on = $('sudo').checked;
      document.querySelectorAll('.sudo-row').forEach((el) => el.classList.toggle('hidden', !on));
    }
    $('sudo').addEventListener('change', syncSudo);
    syncSudo();

    $('save').addEventListener('click', () => {
      status.className = '';
      status.textContent = 'Saving…';
      vscode.postMessage({ type: 'save', data: collect() });
    });
    $('test').addEventListener('click', () => {
      status.className = '';
      status.textContent = 'Testing connection…';
      vscode.postMessage({ type: 'test', data: collect() });
    });
    $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'testResult') {
        status.className = msg.ok ? 'ok' : 'err';
        status.textContent = (msg.ok ? '✓ ' : '✗ ') + msg.message;
      }
    });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    ConnectionEditorPanel.openPanels.delete(this.key);
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
