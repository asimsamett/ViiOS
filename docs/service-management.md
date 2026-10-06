# Service Manager — Phase 3

Open **Servisler** from the ViiOS desktop menu, or use `?view=services`. The tool
supports search, state filtering, sorting, pagination, current details and explicit
confirmation before a lifecycle or startup change. Desktop/Dock layouts retain
the new tool using the existing per-server layout format. The existing application
control screen remains available.

## Platform behavior

| Operation | Linux | Windows |
| --- | --- | --- |
| Inventory | Installed and loaded systemd service units | Windows SCM service inventory |
| Lifecycle | Start, stop, restart | Start, stop, restart |
| Startup | Enable / disable, without `--now` | Automatic / manual / disabled; running state unchanged |
| Logs | Last 100 journal entries in the past 24 hours; API maximum 200 | Event Log integration is not implemented in this phase |

Non-systemd Linux hosts return an explicit unsupported state. Agent updates are
required on existing remote targets. Starting the local lab does not install an
agent or change a remote server.

## Management policy

Inventory is readable through the authenticated server connection. Mutations
require an administrator-owned allowlist. This preserves the existing Windows
service-control policy instead of enabling control of every operating-system service.
Critical services and the management/SSH service remain protected even if listed.

On Windows, merge the application service into the `services` array in
`C:\ProgramData\ViiOS\agent\windows-agent.json`, preserving the other settings:

```json
{"name": "ExampleAppService", "ports": [8080]}
```

The new Service Manager uses the service name. The existing application-control
screen also uses the registered ports. The agent must run with administrator
privileges. Shared-process services, inaccessible identities and transitional
states are read-only. Active dependents block stop/restart; unavailable dependencies
block start/restart. The CIM stop operation does not cascade to dependent services.

On Linux, an administrator may create `/var/lib/viios-agent/services.json`:

```json
{"allowedServices": ["example-app.service"]}
```

The file and its parent must be owned by root and not writable by group/others;
symlinks are rejected. A missing policy means read-only service management. Only
canonical, installed, persistent service instances are eligible. Critical units,
units containing the management process, transient/template units and inappropriate
states remain protected. Dependency checks refuse implicit starts and active stop
dependents. Socket-triggered units cannot be stopped through this screen. These
checks do not replace systemd's own transaction and service-configuration behavior;
administrator changes made concurrently can still make an operation fail.

Every mutation includes a service-state/configuration token. Stale details are
rejected, and the resulting state is reread before success is reported. The API
serializes mutations per target; Windows uses the existing shared control mutex,
and Linux uses a protected nonblocking file lock. Timeouts never imply that a
submitted operating-system operation was rolled back; refresh the details.

No executable command, environment, service account credential or raw command error
is returned. Journal messages are bounded and common password/token/authorization
patterns are masked. This is best-effort redaction: application logs may contain
other sensitive information and should not be published without review.

## Local test fixture and verification limits

`npm run lab` lists real local Windows services as read-only and adds a clearly
labelled **ViiOS Lab Service**. This is a disposable, process-based supervisor
fixture, **not an installed Windows SCM service**. Only this fixture permits
service mutations in the local lab. Its real HTTP listener is on `127.0.0.1:3291`.
Stop closes the listener; start waits for readiness; restart replaces the process.
Startup preferences are stored under ignored `data/server-lab/service.json` and
apply when the lab restarts. The fixture has its own bounded operation log.

The current local Windows session is not elevated, so SCM creation and real Windows
service mutation were not exercised. Windows adapter mutation tests use isolated
CIM/service-controller doubles. Real enumeration/details, authenticated SSH/API
transport, fixture lifecycle/readiness and UI interactions are exercised locally.
Linux systemd parsing, policy, dependency guards, tokens, journal decoding and
command/result verification have fixture tests; a live Linux host is still needed
for end-to-end systemd/journal verification.

Useful checks:

```powershell
npm test
npm run check
npm run lint
npm run build
powershell -NoProfile -File tests/windows-services.test.ps1
python tests/test_services.py
python scripts/package-source.py --check
```

Runtime state, keys, credentials, local host information and test artifacts stay in
ignored `data/` and `outputs/` directories and are excluded from public source packaging.
