# Windows target support

**English** | [Türkçe](windows-support.tr.md)

<!-- docs-nav:start -->
[Home](../README.md) · [Contributing](../CONTRIBUTING.md) · [License](licensing.md) · [Security](../SECURITY.md)

[Demo](demo.md) · [Server connections](connections.md) · **Windows support** · [Validation](validation.md) · [Copyright notices](notices.md) · [Third parties](../THIRD_PARTY_NOTICES.md)
<!-- docs-nav:end -->

ViiOS can use a Windows controller or a Linux controller to manage a Windows target over SSH. The target runs `server/agent/windows-agent.ps1` using Windows PowerShell 5.1 or later. The controller does not need PowerShell when connecting to a Windows target from Linux.

The target must already have OpenSSH Server installed, running, reachable, and configured for the selected account. ViiOS cannot install its first SSH transport across a network without an existing administrative transport. Bootstrap requires an elevated administrator account. Windows PowerShell 5.1, CIM, and the NetTCPIP module are used; Python, WSL, Git, Docker, and a Linux compatibility layer are not required for the native adapter.

The installer places the trusted script at `C:\ProgramData\ViiOS\agent\windows-agent.ps1`. The agent directory, script, and optional configuration must be writable only by Administrators and SYSTEM. The script runs with the SSH account's rights; its checks restrict supported actions but do not replace Windows ACLs or authorization on the controller.

## Wire contract

The SSH launcher chooses a fixed helper name and invokes the installed script with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ... -Helper <name>`. Request data travels exclusively as a UTF-8 JSON object on standard input; it is never inserted into a command line or evaluated as PowerShell. Close standard input after the JSON object. Empty input is treated as `{}`.

Each invocation returns one UTF-8 JSON value without a BOM. Errors are JSON objects with `ok: false`, `available: false`, `status`, and a safe `error` message. Callers must inspect the JSON error; they must not infer success from the process exit code. Raw exception messages, command arguments, credentials, and service command lines are not returned.

| Helper | Supported behavior |
| --- | --- |
| `capabilities` | Agent version, OS, administrator status, PowerShell version, public capability booleans, and limitations. |
| `scan` | TCP listeners and UDP bindings, owning process, service association, executable directory, optional numeric port range, and bounded local HTTP/HTTPS metadata discovery. |
| `resources` | Sampled CPU, working-set memory, process I/O, listener process trees, host memory/pagefile/uptime, and all mounted fixed-volume totals. |
| `storage` | `overview`, bounded `usage`, and bounded `apps`/`applications` metadata snapshots. |
| `files` | Capabilities, virtual drive/root navigation, list/search/read/download/properties, create/write/mkdir/upload, regular-file copy, same-volume move, recoverable trash and restore. |
| `control` | Status and start/stop/restart for explicitly registered standalone application services only. |
| `models` | Read-only discovery from the fixed local Ollama `/api/tags` endpoint, if reachable. |
| `versions` | Explicit unavailable capability and structured unsupported-operation responses. Existing repositories are untouched. |
| `concurrency` | Explicit unavailable capability; no invented model workload or GPU measurements. |

Feature availability is not proof that a particular target resource is accessible. For example, model discovery returns `available: false` when local Ollama cannot be reached. An empty service allowlist sets the control capability to false and provides no service mutation controls. This initial Windows implementation requires an administrator to register application services in the target configuration; there is no service-registration UI yet. Windows version management, Git history, model concurrency telemetry, streaming upload, ZIP export, and recursive directory copy are currently unavailable.

## Virtual paths and file roots

The frontend uses slash-based virtual paths: `/` lists fixed drives, `/C:` is a drive node, and `/C:/Users/example/Projects` is a native directory. UNC, device paths, alternate data streams, dot traversal, reserved device names, trailing dots/spaces, control characters, and nonlocal/removable drives are rejected. Reparse points, junctions, and symbolic links are not followed. Multiple-hard-link files cannot be opened for contents or copied.

Default file-management roots are existing directories from `/C:/Users`, `/C:/Projects`, `/C:/inetpub`, and `/C:/Apps`. Other drive letters work through explicit roots. Neither a configured root nor an ancestor containing another configured root can be replaced, moved, or trashed. System, agent, credential, and profile-state locations such as Windows, Program Files, ProgramData, AppData, `.ssh`, `.gnupg`, and `.codex` are protected, even inside an allowed root.

An administrator can create `C:\ProgramData\ViiOS\agent\windows-agent.json` to narrow roots and register application services:

```json
{
  "roots": ["/C:/Apps", "/D:/Projects"],
  "services": [
    { "name": "ContosoWeb", "ports": [8080] }
  ]
}
```

Only existing local fixed-drive directories are exposed. Keep this configuration under the administrator-only ACL of the agent directory; never place an editable configuration inside an application directory.

Writes require the current opaque file revision. The adapter opens the file without following a final reparse point, takes an exclusive file handle, and checks its identity/revision again before changing bytes. New destinations use create-new semantics. Copy, move, and trash require a source revision; copy holds a read handle while transferring. Directory ancestry is held against rename/replacement while bounded scans and file operations use it. These checks detect ordinary stale UI edits. A write is flushed in place and is not an atomic transaction against power loss. Move/trash revision checking is optimistic, not a cross-process compare-and-swap transaction.

Recoverable trash lives in each root's `.viios-trash` directory, so moves remain on the same volume. Restore refuses to overwrite an existing destination. There is no permanent recursive delete operation or automatic trash purge. Windows ACLs inherited by the configured root also govern its trash.

Text editing is bounded at 1 MiB. JSON uploads and file downloads are bounded at 16 MiB; base64 is used for binary transfer. A regular-file copy is bounded at 200 MiB. Directory copying, cross-volume moves, and streaming ZIP operations return explicit unsupported responses. File capabilities include `streamUpload: false`, `streamExport: false`, `directoryCopy: false`, and the numeric limits so the UI can disable those flows.

## Resource and storage measurements

Web discovery sends only `GET /` to addresses reported by local TCP listeners. Wildcard bindings map to loopback; explicit private local bindings are supported. Public/external addresses, UDP-only bindings, and common non-HTTP infrastructure ports are excluded. Probes have at most six concurrent workers, 128 candidates, a 20 second scheduling budget, 1.2 second attempts, and 32 KiB response bounds. Redirects are never followed. A valid HTTP status line enables app opening; unrecognized protocols remain ordinary services. HTTPS uses a per-connection certificate callback for local discovery and exposes `tlsUnverified: true` if trust or hostname validation failed; it never changes process-wide certificate validation. Host-specific virtual hosts may require additional configuration, and a slow server can remain unrecognized until a later scan.

TCP/UDP listener process IDs seed the resource groups. Descendants belong to their nearest listening ancestor so overlapping process trees are not counted twice. CPU uses an approximately 650 ms delta normalized by logical processor count. A changed/missing process identity makes the affected sample unavailable. Windows process read/write counters represent all I/O, not just physical disk transfers. Windows does not expose Linux load averages; that field is empty with an explanatory note.

Storage overview uses mounted local fixed volumes from CIM, deduplicated by volume identity. Native capacity calls distinguish free space from space available to the SSH account. Unmounted recovery partitions without a normal drive/mount path are excluded. Volume totals and directory totals answer different questions: filesystem metadata, other users' protected data, and reserved capacity can account for the difference.

Folder scans inspect allocation metadata through `FileStandardInfo`; no file contents are read. They count allocated bytes, deduplicate hard links within each scanned tree, and skip reparse entries, protected paths, inaccessible files, and volume changes. Directory scans are bounded by both time and entry counts, typically 15,000 entries and up to 8 seconds per scan. A storage usage request has a 12 second total budget and at most 200 direct entries. Application directory measurements have a 20 second total budget, at most 100 paths, and at most 5 seconds per path. Paths shared by applications are not additive.

Skipped or budget-limited results set `partial: true`, with `reason` explaining that values are lower bounds. Unavailable measurements use `null`, never a fabricated zero. Results are synchronous bounded snapshots with `status: ready`; a controller may cache/poll them independently. No recursive drive-wide background crawl is scheduled by this adapter.

## Service controls

Control registrations name an exact Windows service and its expected ports. A service must be a standalone own-process service, not disabled, and stable in Running or Stopped state. A registered port owned by another process disables control. SSH, WinRM, ViiOS, and core system service names are protected even if entered in configuration. Unregistered listeners remain viewable but cannot be killed or controlled.

Control tokens hash the service name, PID, process start identity, service state, and registered ports. A fresh snapshot must match the submitted token immediately before the operation. Only fixed start/stop/restart actions are possible. Stop uses the CIM `StopService` method, which refuses running dependents; it deliberately avoids the cascading .NET Framework `ServiceController.Stop()` method. Start refuses stopped prerequisites rather than starting them implicitly. The adapter waits for the requested service state; subsequent inventory verifies listeners. It never accepts arbitrary process termination, scripts, executable paths, shell commands, or custom verbs.

## Local verification

Run the test suite from the standalone checkout on Windows:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -File tests/windows-agent.test.ps1
pwsh.exe -NoLogo -NoProfile -NonInteractive -File tests/windows-agent.test.ps1
```

Tests create and remove only a unique sandbox under `tests/.windows-agent-test`. They cover path rejection, protected roots, create/read/write and stale revisions, copy/move/trash/restore, bounded upload/download/search/allocation, hard links and junctions, mocked TCP/UDP/CIM inventory, service allowlists, protected services, stale control tokens, controller envelopes, and explicit unsupported capabilities. Temporary loopback HTTP fixtures verify metadata recognition, no external redirect following, non-HTTP rejection, and UDP exclusion. They do not operate real services or remote servers.

Read-only smoke requests can use the installed fixed script with helper `capabilities`, `scan`, `resources`, or `storage` with `{"action":"overview"}`. Avoid pointing a folder scan at an entire drive for routine validation; the test sandbox provides a bounded fixture. Windows-to-Windows and Linux-to-Windows SSH bootstrap require their own target integration checks beyond these local adapter tests.
