# Remote Workspace (SSH/SFTP)

Open any remote Linux folder over **SSH/SFTP**, edit files **natively** in VS Code,
and open remote terminals — **without installing a server** on the remote host.

Unlike Microsoft's Remote‑SSH (which runs a full VS Code Server remotely), this
extension keeps the extension host **local** and talks to the remote purely over
SFTP via VS Code's `FileSystemProvider` API. That means it works even on
locked‑down or embedded hosts that can't run a remote server — and it runs on
**VS Code, VSCodium, and forks** (Cursor/Windsurf), using only stable APIs.

## Features (v1)

- **SFTP virtual filesystem** — browse, open, edit, create, rename, delete,
  upload and download files under `ssh://<connection-id>/<path>`.
- **Native editing** with **write‑through saves** and **remote change
  detection** (warns before overwriting a file that changed on the server).
- **Remote Explorer** tree in the activity bar listing all connections and
  letting you browse the remote filesystem.
- **Two ways to define connections**:
  - automatically read from your existing **`~/.ssh/config`**, and
  - a **webview editor** to create/edit/**test** connections.
- **Integrated terminal over SSH** (real interactive shell in the panel).
- **Authentication**: private key (+passphrase), password, SSH **agent**
  (incl. Pageant on Windows), **ProxyJump** bastion hosts, and
  **keyboard‑interactive / 2FA**.

> Port forwarding and remote task runners are intentionally **out of scope for
> v1** but the codebase has a `remoteServices` extension point reserved for them.

## Architecture

```
                ┌──────────────────────────── VS Code (local extension host) ────────────────────────────┐
                │                                                                                          │
  Remote        │   commands.ts ── ConnectionEditorPanel (webview)                                        │
  Explorer ◄────┤        │                                                                                │
  (tree)        │        ▼                                                                                │
                │   ConnectionStore ◄── ~/.ssh/config (sshConfig.ts) + settings.json                      │
                │        │                                                                                 │
   ssh:// URIs  │        ▼                                                                                 │
  ────────────► │   RemoteFileSystemProvider ──► ConnectionManager ──► SSHConnection ──► ssh2 ──► remote   │
   (editor I/O) │                                      │  (pool, ProxyJump)     (SFTP / shell / exec)      │
                │   RemoteTerminal (Pseudoterminal) ───┘                                                   │
                └──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | File | Responsibility |
| --- | --- | --- |
| Entry | `src/extension.ts` | Wire everything; register FS provider + tree + commands |
| Config | `src/config/*` | Normalize connections from `~/.ssh/config` and settings |
| Transport | `src/ssh/*` | `ssh2` connection pool, auth, SFTP helpers, ProxyJump |
| Filesystem | `src/fs/*` | `FileSystemProvider` over SFTP; `ssh://` URI scheme |
| Views | `src/views/*` | Remote Explorer tree |
| Webview | `src/webview/*` | Connection create/edit/test form |
| Terminal | `src/terminal/*` | Pseudoterminal backed by an SSH shell |
| Extensibility | `src/remoteServices/*` | Reserved hook for port‑forwarding / tasks |

## Develop / run

```bash
npm install
npm run compile      # or: npm run watch
npm run check-types
```

Then press **F5** in VS Code ("Run Extension") to launch an Extension
Development Host. Open the **Remote Workspace** view in the activity bar, add a
connection (or use one from `~/.ssh/config`), then **Open Remote Folder**.

### Packaging

```bash
npm run package                 # production bundle into dist/
npx @vscode/vsce package        # produce a .vsix
```

## Settings

| Setting | Description |
| --- | --- |
| `remoteWorkspace.connections` | User‑defined connections (no secrets). |
| `remoteWorkspace.hostMetadata` | Label/default‑folder overrides for `~/.ssh/config` hosts. |
| `remoteWorkspace.showSshConfigHosts` | Show `~/.ssh/config` hosts in the tree. |
| `remoteWorkspace.sshConfigPath` | Override the OpenSSH config path. |
| `remoteWorkspace.connectTimeoutMs` | Handshake timeout. |
| `remoteWorkspace.keepaliveIntervalMs` | SSH keepalive interval. |

Passwords and key passphrases are stored in **VS Code SecretStorage**, never in
settings.

## Known limitations (v1 skeleton)

- No live file watching yet (`watch()` is a no‑op — SFTP has no inotify). Use
  refresh to re‑read directories.
- Symlinks are surfaced by their target type when browsing.
- Cross‑connection moves are not supported (single‑host SFTP rename only).
- ProxyJump supports chained jumps; multi‑factor on the jump host reuses the
  same interactive prompts.
