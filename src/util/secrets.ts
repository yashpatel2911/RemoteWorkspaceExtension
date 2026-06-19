import * as vscode from 'vscode';

/**
 * Namespaced access to VS Code SecretStorage so passwords and key passphrases
 * never touch settings.json. Keys are derived from the connection id.
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private passwordKey(id: string): string {
    return `remoteWorkspace.password.${id}`;
  }

  private passphraseKey(id: string): string {
    return `remoteWorkspace.passphrase.${id}`;
  }

  getPassword(id: string): Thenable<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  setPassword(id: string, value: string): Thenable<void> {
    return this.secrets.store(this.passwordKey(id), value);
  }

  getPassphrase(id: string): Thenable<string | undefined> {
    return this.secrets.get(this.passphraseKey(id));
  }

  setPassphrase(id: string, value: string): Thenable<void> {
    return this.secrets.store(this.passphraseKey(id), value);
  }

  async clear(id: string): Promise<void> {
    await this.secrets.delete(this.passwordKey(id));
    await this.secrets.delete(this.passphraseKey(id));
  }
}
