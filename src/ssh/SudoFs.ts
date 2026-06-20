import { ConnectionConfig } from '../config/types';
import { SecretStore } from '../util/secrets';
import { Logger } from '../util/logger';
import { SSHConnection } from './SSHConnection';
import { AuthPrompts } from './auth';
import {
  RemoteDirEntry,
  RemoteFs,
  RemoteFsError,
  RemoteFileType,
  RemoteStat,
} from './RemoteFs';

interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

const VALID_USER = /^[A-Za-z0-9._-]+$/;

/**
 * Run sudo from "/" rather than the login user's home. The SSH session's cwd is
 * the login user's home (e.g. /home/yashpatel2911), which the target user often
 * can't access; `find` restores its initial cwd on exit and would fail there.
 * "/" is accessible to everyone, so any cwd-sensitive command is safe.
 */
const FROM_ACCESSIBLE_CWD = 'cd / && ';

/**
 * Filesystem that performs every operation as another user via `sudo -u <user>`,
 * driven by shell commands over the existing SSH `exec` channel (ssh2 cannot
 * cleanly elevate the sftp-server). Auth is auto-detected: passwordless if the
 * sudoers policy allows it, otherwise the login user's sudo password is used
 * (from SecretStorage or an interactive prompt) to refresh the sudo timestamp.
 *
 * The integrated terminal is intentionally NOT routed through this — it stays as
 * the SSH login user.
 */
export class SudoFs implements RemoteFs {
  private readonly user: string;
  private validated = false;
  private validating?: Promise<void>;
  /** Whether the sudoers policy lets us run without a password, decided once. */
  private mode: 'nopasswd' | 'password' | undefined;
  /** Login user's sudo password, kept in memory for this session (password mode). */
  private password?: string;

  constructor(
    private readonly conn: SSHConnection,
    private readonly config: ConnectionConfig,
    private readonly secrets: SecretStore,
    private readonly prompts: AuthPrompts,
    private readonly logger: Logger,
  ) {
    this.user = config.sudoUser && config.sudoUser.length > 0 ? config.sudoUser : 'root';
  }

  // ---- public RemoteFs ------------------------------------------------------

  async stat(path: string): Promise<RemoteStat> {
    const res = await this.runSudo(`stat -c '%s|%Y|%F' -- ${q(path)}`);
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
    const text = res.stdout.toString('utf8').trim();
    const [sizeStr, mtimeStr, ...typeParts] = text.split('|');
    return {
      type: wordToType(typeParts.join('|')),
      size: Number(sizeStr) || 0,
      mtimeMs: (Number(mtimeStr) || 0) * 1000,
    };
  }

  async readDirectory(path: string): Promise<RemoteDirEntry[]> {
    // One round-trip; %y type, %f basename, NUL-separated records (newline-safe).
    const res = await this.runSudo(
      `find ${q(path)} -maxdepth 1 -mindepth 1 -printf '%y\\t%f\\0'`,
    );
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
    const out: RemoteDirEntry[] = [];
    for (const record of res.stdout.toString('utf8').split('\0')) {
      if (!record) {
        continue;
      }
      const tab = record.indexOf('\t');
      if (tab < 0) {
        continue;
      }
      out.push({ name: record.slice(tab + 1), type: findCodeToType(record.slice(0, tab)) });
    }
    return out;
  }

  async readFile(path: string): Promise<Buffer> {
    const res = await this.runSudo(`cat -- ${q(path)}`);
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
    return res.stdout;
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const res = await this.runSudo(`tee -- ${q(path)} > /dev/null`, data);
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
  }

  async createDirectory(path: string): Promise<void> {
    const res = await this.runSudo(`mkdir -- ${q(path)}`);
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
  }

  async delete(path: string, options: { recursive: boolean }): Promise<void> {
    const st = await this.statQuiet(path);
    let inner: string;
    if (st?.type === 'directory') {
      inner = options.recursive ? `rm -rf -- ${q(path)}` : `rmdir -- ${q(path)}`;
    } else {
      inner = `rm -f -- ${q(path)}`;
    }
    const res = await this.runSudo(inner);
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
  }

  async rename(from: string, to: string, options: { overwrite: boolean }): Promise<void> {
    const res = await this.runSudo(`mv ${options.overwrite ? '-f' : '-n'} -- ${q(from)} ${q(to)}`);
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
  }

  async realpath(path: string): Promise<string> {
    if (path === '.') {
      // Target user's home, read from the passwd db (no elevation needed).
      const res = await this.exec(`getent passwd ${q(this.user)}`);
      const home = res.code === 0 ? res.stdout.toString('utf8').trim().split(':')[5] : undefined;
      return home && home.length > 0 ? home : `/home/${this.user}`;
    }
    const res = await this.runSudo(`realpath -- ${q(path)}`);
    if (res.code !== 0) {
      throw classify(res.stderr);
    }
    return res.stdout.toString('utf8').trim();
  }

  // ---- sudo bootstrap -------------------------------------------------------

  /** Ensure we can run commands as `user` without further prompting. */
  ensureSudo(): Promise<void> {
    if (this.validated) {
      return Promise.resolve();
    }
    if (!this.validating) {
      this.validating = this.doEnsure()
        .then(() => {
          this.validated = true;
          this.logger.info(`sudo elevation ready for ${this.config.id} → ${this.user}`);
        })
        .finally(() => {
          this.validating = undefined;
        });
    }
    return this.validating;
  }

  private async doEnsure(): Promise<void> {
    if (!VALID_USER.test(this.user)) {
      throw new RemoteFsError('EACCES', `Invalid sudo user "${this.user}".`);
    }

    // 1) Probe non-interactively. This also tells us if the run-as user is even
    //    permitted, before bothering the user for a password.
    const probe = await this.exec(`${FROM_ACCESSIBLE_CWD}sudo -n -u ${q(this.user)} -- true`);
    if (probe.code === 0) {
      this.mode = 'nopasswd';
      return;
    }
    const probeKind = sudoStderrKind(probe.stderr);
    if (probeKind === 'denied') {
      throw this.deniedError(probe.stderr);
    }
    if (probeKind === 'tty') {
      throw this.ttyError(probe.stderr);
    }

    // 2) A password is required. Use stored secret first, then prompt.
    let password = await this.secrets.getSudoPassword(this.config.id);
    const fromStore = !!password;
    if (!password) {
      password = await this.prompts.promptSudoPassword(this.config, this.user);
    }
    if (!password) {
      throw new RemoteFsError('EACCES', 'Sudo password is required to elevate.');
    }

    let verdict = await this.verifyPassword(password);
    if (verdict === 'badpass' && fromStore) {
      this.logger.warn(`Stored sudo password rejected for ${this.config.id}; re-prompting`);
      const fresh = await this.prompts.promptSudoPassword(this.config, this.user);
      if (fresh) {
        password = fresh;
        verdict = await this.verifyPassword(password);
      }
    }
    if (verdict === 'denied') {
      throw this.deniedError('sudo refused the run-as user');
    }
    if (verdict === 'tty') {
      throw this.ttyError('sudo requires a TTY');
    }
    if (verdict !== 'ok') {
      throw new RemoteFsError('EACCES', 'Sudo authentication failed — check your sudo password.');
    }

    this.mode = 'password';
    this.password = password;
  }

  /** Authenticate once with the password to confirm it works and is permitted. */
  private async verifyPassword(password: string): Promise<'ok' | 'badpass' | 'denied' | 'tty' | 'error'> {
    const res = await this.exec(
      `${FROM_ACCESSIBLE_CWD}sudo -k -S -p '' -u ${q(this.user)} -- true`,
      Buffer.from(`${password}\n`),
    );
    if (res.code === 0) {
      return 'ok';
    }
    const kind = sudoStderrKind(res.stderr);
    if (kind === 'denied') {
      return 'denied';
    }
    if (kind === 'tty') {
      return 'tty';
    }
    if (kind === 'password' || /try again|incorrect password|sorry/i.test(res.stderr)) {
      return 'badpass';
    }
    return 'error';
  }

  /**
   * Run a command as the target user. In password mode the sudo password is
   * supplied on stdin for EVERY command (sudo reads the first line, the command
   * inherits the rest) — sudo timestamps are unreliable across separate exec
   * channels, so we never depend on a cached timestamp. `-k` forces a fresh auth
   * so the password line is always consumed and never leaks to the command.
   */
  private async runSudo(inner: string, stdin?: Buffer): Promise<ExecResult> {
    await this.ensureSudo();
    if (this.mode === 'password') {
      const credential = Buffer.from(`${this.password}\n`);
      const input = stdin ? Buffer.concat([credential, stdin]) : credential;
      return this.exec(
        `${FROM_ACCESSIBLE_CWD}sudo -k -S -p '' -u ${q(this.user)} -- ${inner}`,
        input,
      );
    }
    return this.exec(`${FROM_ACCESSIBLE_CWD}sudo -n -u ${q(this.user)} -- ${inner}`, stdin);
  }

  private deniedError(detail: string): RemoteFsError {
    const login = this.config.username || 'your login user';
    return new RemoteFsError(
      'EACCES',
      `"${login}" is not permitted by the sudoers policy on ${this.config.host} to run commands as "${this.user}". ` +
        `Pick a permitted target (commonly "root"), or add a sudoers rule. (${detail.trim()})`,
    );
  }

  private ttyError(detail: string): RemoteFsError {
    return new RemoteFsError(
      'EACCES',
      `sudo on ${this.config.host} requires a TTY ('Defaults requiretty'), which this mode cannot provide. ` +
        `Remove requiretty or add a NOPASSWD rule for "${this.user}". (${detail.trim()})`,
    );
  }

  private async statQuiet(path: string): Promise<RemoteStat | undefined> {
    try {
      return await this.stat(path);
    } catch (err) {
      if (err instanceof RemoteFsError && err.code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  /** Run a command over a fresh exec channel and capture stdout/stderr/exit. */
  private async exec(command: string, stdin?: Buffer): Promise<ExecResult> {
    const chan = await this.conn.exec(command);
    return new Promise<ExecResult>((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let code: number | null = null;
      chan.on('data', (d: Buffer) => out.push(d));
      chan.stderr?.on('data', (d: Buffer) => err.push(d));
      chan.once('error', reject);
      chan.on('exit', (c: number | null) => {
        code = c;
      });
      chan.on('close', (c?: number | null) => {
        const exit = code ?? (typeof c === 'number' ? c : 0);
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
          code: exit ?? 0,
        });
      });
      if (stdin !== undefined) {
        chan.end(stdin);
      } else {
        chan.end();
      }
    });
  }
}

/** POSIX single-quote a string so it is safe inside a remote shell command. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function wordToType(word: string): RemoteFileType {
  if (/directory/i.test(word)) {
    return 'directory';
  }
  if (/symbolic link/i.test(word)) {
    return 'symlink';
  }
  return 'file';
}

function findCodeToType(code: string): RemoteFileType {
  if (code === 'd') {
    return 'directory';
  }
  if (code === 'l') {
    return 'symlink';
  }
  return 'file';
}

/** Interpret sudo's own stderr (auth failures, not the wrapped command's). */
function sudoStderrKind(stderr: string): 'password' | 'denied' | 'tty' | 'other' {
  const s = stderr.toLowerCase();
  if (
    /not in the sudoers file|not allowed to (execute|run)|may not run sudo|is not allowed to run|unknown user/.test(s)
  ) {
    return 'denied';
  }
  if (/you must have a tty|requires? a tty|no tty present/.test(s)) {
    return 'tty';
  }
  if (/a password is required|^\s*password:/.test(s)) {
    return 'password';
  }
  return 'other';
}

function classify(stderr: string): RemoteFsError {
  const s = stderr.toLowerCase();
  if (/no such file or directory/.test(s)) {
    return new RemoteFsError('ENOENT', stderr.trim());
  }
  if (/file exists/.test(s)) {
    return new RemoteFsError('EEXIST', stderr.trim());
  }
  if (/permission denied|operation not permitted|not allowed|a password is required|may not run/.test(s)) {
    return new RemoteFsError('EACCES', stderr.trim());
  }
  return new RemoteFsError('EUNKNOWN', stderr.trim() || 'sudo command failed');
}
