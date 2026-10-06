# Server connections and automatic setup

**English** | [Türkçe](connections.tr.md)

The ViiOS controller runs on Windows or Linux using Node.js. Add targets through **Servers → Add server** (**Sunucular → Sunucu ekle**). Connections use the application's SSH2 client, without the computer's personal SSH configuration, an SSH agent, or an AI service.

## Prerequisites

- The target must be reachable over the network with SSH/SFTP enabled. ViiOS cannot remotely install its initial SSH transport on a machine without existing SSH access.
- Linux requires a local root account or an account that can gain administrative access through sudo. If missing, setup installs Python 3, Git, iproute2, sudo, and user-management tools through apt, dnf, yum, zypper, apk, or pacman. Unsupported package managers produce an explicit setup error. The `acl` package and `getfacl` / `setfacl` commands are optional; their absence does not block setup or trigger installation.
- Windows requires Windows PowerShell 5.1 and Windows OpenSSH Server/SFTP. The account must have administrator privileges within its SSH session; a session not elevated because of UAC is insufficient. ViiOS does not remotely change UAC settings.
- Linux dependency installation requires access to the target's package repositories. The Windows adapter does not require an additional Python or Node.js installation.

## Onboarding flow

1. Enter the display name, IP/DNS address, SSH port, and target operating system.
2. **Check server key** (**Sunucu anahtarını denetle**) retrieves the SSH key's SHA-256 fingerprint without sending a username or password. Verify it through a separate trusted source, such as the server console or administrator, then confirm it in the interface.
3. Enter the SSH username and password or private key. Encrypted private-key passphrases are supported. Supply a separate Linux sudo password if necessary.
4. ViiOS verifies the confirmed host key before authentication. The interface tracks platform/privilege checks, dependencies, file transfer, installation, and capability verification.
5. The ready server is added to the inventory. Unsupported or unverified capabilities are identified separately, rather than represented as empty measurements or zero usage.

A changed host key stops the connection. A normal retry does not replace the saved fingerprint. For a planned key change, open the connection editor, verify the new fingerprint independently, and explicitly confirm it before saving and reconnecting. Removing and re-adding the local record is also possible, but does not preserve that record's identity and layout.

## What is installed on the target?

Linux files are transferred using the package's explicit manifest. Temporary files are uploaded to a private SFTP directory, with sizes and SHA-256 digests verified. Python files are checked for syntax errors. Only bundled helper files are installed.

- Releases: `/opt/viios-agent-releases/release-*`
- Active release link: `/opt/viios-agent`
- State directory: `/var/lib/viios-agent`
- Git operations: the `viios-agent` system account, without interactive login
- Sudo rules: exact helper commands under `/etc/sudoers.d/viios-agent-*`

Helper code and rules are owned by root; rules are validated with `visudo`. No unrestricted sudo rule or general shell access is added. Existing installation directories not recognized as ViiOS are not automatically replaced. Previous ViiOS release directories are retained for rollback.

The Windows adapter is installed at `C:\ProgramData\ViiOS\agent\windows-agent.ps1`, with its SHA-256 digest verified. Access to the directory and existing files is restricted to Administrators and SYSTEM. Updates replace the script atomically and retain the previous version as `windows-agent.previous.ps1`. Existing server applications and services are not started or stopped during installation.

## Credentials

The controller stores SSH passwords or private keys in `connections/servers.json` within its private data directory, encrypted using AES-256-GCM. Credentials are bound to the server ID, address, port, username, operating system, authentication type, and pinned host key. List APIs do not return encrypted or plaintext credentials.

The encryption key is stored in `connections/master.key`. POSIX permissions are 0700 for directories and 0600 for files. On Windows, access is limited to the account running the controller and SYSTEM. This is not a separate vault protecting against compromise of that same operating-system account. Keep server records and their key together in a secure backup. If the key is lost, it is not silently regenerated for existing records.

A sudo password is kept only in the active installation job's memory and is never saved to disk. Passwords are not placed on command lines; they are passed to sudo through the SSH command's standard input. Errors do not expose raw remote output or credentials.

## Edit, retry, and remove

Use **Edit** (**Düzenle**) in the Servers screen to update an existing connection. You can replace its address, platform, username, or authentication details and verify its fingerprint again. Keeping saved credentials does not reveal them in the interface. Saving and reconnecting preserves the server ID, data directory, and desktop layout. An existing installation attempt is cancelled before restarting setup.

At most two servers are prepared concurrently; other jobs wait in the queue. Retries for the same server are coalesced. Operations enforce timeouts and output limits. If ViiOS closes during setup, the job is marked interrupted; restarting the application does not automatically rerun setup that may require a password.

**Retry** (**Yeniden dene**) reuses saved SSH credentials and the pinned fingerprint. A different sudo password may be supplied. For an incorrect SSH password, key, or address, edit the connection. **Remove** (**Kaldır**) deletes the local record and closes active connections; it does not remove remote helpers or server applications.

Linux and Windows support do not imply identical capabilities. Windows Git version management and model concurrency measurements are unavailable in this version. See [Windows target support](windows-support.md) for file and service-control limits. UAT environments are disabled on both platforms.

## Optional ACL tools

Linux setup checks whether `getfacl` and `setfacl` can be found, and reports the result as `capabilities.aclTools`. Missing tools are informational and do not stop installation. This check does not establish whether a filesystem supports ACLs. Project access preparation uses Python directly. If an actual ACL operation is unsupported or denied, the application displays an explanatory popup; monitoring and operations permitted by existing access rights can continue.

## API contract

These endpoints require a ViiOS administrator session. Mutations also enforce same-origin protection.

| Method | Endpoint | Behavior |
|---|---|---|
| GET | `/api/connections` | Returns the `servers` array. |
| POST | `/api/connections/probe` | Accepts `host`, `port`, and `platform`; returns `fingerprint` and `algorithm`. Does not accept credentials. |
| POST | `/api/connections` | Accepts `name`, `host`, `port`, `username`, `platform`, `authType`, `fingerprint`, and applicable `password`/`privateKey`/`passphrase` fields. Optional `sudoPassword` applies only to this setup attempt. Returns HTTP 202 and the `server` record. |
| GET | `/api/connections/:id` | Returns the `server` record. |
| PUT | `/api/connections/:id` | Updates the connection and restarts setup. Returns HTTP 202 and the `server` record. |
| POST | `/api/connections/:id/retry` | Accepts an optional `sudoPassword`; returns HTTP 202 and the `server` record. |
| DELETE | `/api/connections/:id` | Removes the local record and returns an `ok` response. |

Server states are `pending`, `installing`, `ready`, and `error`. The `phase`, `message`, `capabilities`, `updatedAt`, and `errorCode` fields describe progress; private credentials are absent. Each server receives a random ID prefixed with `srv-`. Mutations and host-key probes are limited to 20 requests per minute per IP address.

## Validation scope

Connection tests use a local SSH2 test server to check host-key pinning, credential-free fingerprint probing, password/encrypted-key authentication, JSON standard input, Windows command mapping, and local tunnels. Setup tests use a fake remote executor to check Linux/Windows commands, SFTP manifests, privileges, credential leakage, and partial capabilities. These tests do not connect to production servers. A complete remote installation on a fresh real Linux or Windows target has not been verified by this test suite.
