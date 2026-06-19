import * as vscode from 'vscode';
import { ConnectionConfig } from '../config/types';
import { SecretStore } from '../util/secrets';
import { AuthPrompts, KbPrompt } from './auth';

/**
 * Concrete, VS Code–backed implementation of the auth prompts. Keeps all UI out
 * of the transport layer. When the user enters a secret we offer to persist it
 * in SecretStorage so subsequent connects are non-interactive.
 */
export class VscodeAuthPrompts implements AuthPrompts {
  constructor(private readonly secrets: SecretStore) {}

  async promptPassword(connection: ConnectionConfig): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: `Password for ${this.who(connection)}`,
      prompt: 'Enter SSH password',
      password: true,
      ignoreFocusOut: true,
    });
    if (value) {
      await this.offerToSave(connection, 'password', value);
    }
    return value;
  }

  async promptPassphrase(connection: ConnectionConfig, keyPath: string): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: `Passphrase for ${this.who(connection)}`,
      prompt: `Enter passphrase for key ${keyPath}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (value) {
      await this.offerToSave(connection, 'passphrase', value);
    }
    return value;
  }

  /** Handle ssh2 keyboard-interactive (2FA / OTP / challenge-response). */
  async promptKeyboardInteractive(
    connection: ConnectionConfig,
    name: string,
    instructions: string,
    prompts: KbPrompt[],
  ): Promise<string[]> {
    const answers: string[] = [];
    for (const p of prompts) {
      const answer = await vscode.window.showInputBox({
        title: name || `Authentication for ${this.who(connection)}`,
        prompt: [instructions, p.prompt].filter(Boolean).join('\n'),
        password: !p.echo,
        ignoreFocusOut: true,
      });
      answers.push(answer ?? '');
    }
    return answers;
  }

  private who(connection: ConnectionConfig): string {
    return `${connection.username || '?'}@${connection.host}`;
  }

  private async offerToSave(
    connection: ConnectionConfig,
    kind: 'password' | 'passphrase',
    value: string,
  ): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `Save this ${kind} securely so you aren't asked again?`,
      'Save',
      'Not now',
    );
    if (choice === 'Save') {
      if (kind === 'password') {
        await this.secrets.setPassword(connection.id, value);
      } else {
        await this.secrets.setPassphrase(connection.id, value);
      }
    }
  }
}
