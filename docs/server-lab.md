# Local server management lab — Phases 1–4

This checkout adds **Server Monitor**, **Process Manager** and **Services** to the existing desktop launcher, and expands **Storage** with disk topology and I/O. It uses real
target telemetry through the existing authenticated, server-scoped SSH resource
transport. Desktop/Dock shortcuts and version-1 layout import/export are retained.

## Start on Windows

```powershell
npm ci
npm run build
npm run lab
```

Open `http://127.0.0.1:3280/?view=overview`. The generated local administrator
password is in `data/server-lab/LOGIN.txt`. The ordinary login/session flow remains
enabled, with a separate `viios_lab_session` cookie so logging in or out does not
replace the primary installation's session cookie. A sample HTTP application listens on loopback port 3281 and a restricted
SSH test target on loopback port 2222. Startup refuses occupied ports.

All runtime records, keys, passwords and live host observations stay under the
ignored `data/server-lab` directory. Do not commit or publish that directory.
Restarting the lab reuses its local connection and administrator configuration.
Stop the lab process with Ctrl+C; its controller and helper children are stopped.

## What this validates

- Actual Windows CPU, memory, pagefile, uptime, volume capacity, network adapter
  counters, physical-disk I/O counters and sampled top processes.
- SSH host-key pinning, password authentication, encrypted connection storage,
  existing controller authentication, server-scoped APIs and desktop integration.
- A real loopback HTTP process discovered by the existing Windows scanner.

This is a pre-provisioned SSH integration fixture running on the Windows
host, **not a separate VM or a production OpenSSH installation**. It does not
exercise the privileged production bootstrap or Windows service mutation. It
permits fixed read helpers, termination of its own disposable process, control of a
separate process-based service fixture on loopback port 3291, and forwarding to the
sample HTTP port. File reads and folder scans are restricted to the generated sample-files fixture.
Shell sessions, external forwarding, file mutations and real Windows service
mutations are not provided. The service fixture is labelled explicitly in the UI.

Linux collection is implemented in `server/resources.py`; live Linux/systemd and
Docker integration require a Linux test host. GitHub Pages remains a separate
synthetic-data preview and is not evidence of live server integration.

## Measurement semantics

Missing or inaccessible counters are null, not zero. Old agents continue to supply
basic resource measurements, with an explicit extended-telemetry notice in Monitor.
New agent code must be deployed to existing targets to expose the additional fields;
no existing remote target is updated by starting this lab.

CPU percentages are normalized to total logical CPU capacity. Windows Idle PID 0
is excluded from the busiest processes. Linux disk rates exclude partitions and
stacked dm/md devices; Windows uses physical-disk performance counters. Network
rates are shown per adapter because virtual adapters can duplicate traffic.
Windows CPU temperature is unavailable without an appropriate sensor provider.

The UI refreshes after each completed request while visible, aborts on server/window
change and labels the previous measurement when a refresh fails. Agent objects,
environment variables and process command lines are not forwarded by the Overview
API; its response is an explicit public-field allowlist.

## Process Manager

Open `http://127.0.0.1:3280/?view=processes` or select **Süreç Yöneticisi** in the
desktop launcher. It can be added to Desktop and Dock like the other tools. The
existing application Task Manager is retained.

The process list includes PID, name, CPU, memory, owner, state and start time when
available. Search matches PID, name, owner and state; every data column is sortable.
The table pages through 50 rows at a time. Agent responses are bounded to 10,000
processes with an explicit partial-list notice. Visible windows refresh after each
completed sample, with a 12-second delay; hidden/minimized windows stop polling.
Details fetch current metadata before enabling the confirmation step.

Windows terminates the verified kernel process object forcibly. Linux sends SIGTERM
using a pidfd and reports whether exit was observed within 1.5 seconds. Linux requires
Python/kernel pidfd support for termination; no unsafe PID-only fallback exists.
Process identity is bound to PID and creation time (and boot identity on Linux), so
a recycled PID cannot target an unrelated replacement. System/service processes,
the management helper and its ancestors are protected. Inaccessible processes are
read-only. No command line or environment is returned to the browser.

The local lab writes its disposable Node worker PID to `data/server-lab/worker.json`.
Search for that PID to test termination. All other Windows processes remain read-only
in the lab. A terminated worker is replaced automatically so another test can run.
This restriction is checked by both the SSH fixture and the Windows adapter. The
fixture contains no application work or user data. Windows adapter tests create and
clean up their own separate disposable worker.

Existing remote targets need the updated agent installed through their normal
provisioning path before Process Manager is available. This lab does not update them.
Linux parsing, validation, protection and pinned-handle signaling have automated
fixture tests; live Linux validation still requires a Linux test host.

## In-app feature booklet

Open **Özellik Rehberi** from the ViiOS menu, Start search, or its book icon in the Dock.
The booklet documents the current built-in tools, with categories, Turkish-aware
full-text search, usage steps, capability notes, related chapters, and guarded links
to the corresponding applications. Unsupported tools remain readable; their launch
button explains why it is unavailable on the selected server. No future Network or
centralized Logs implementation is advertised as an existing application.

## Remaining phases

See [Service Manager](service-management.md) for Phase 3 policy, supported operations
and the difference between the local fixture and real operating-system services.

See [Storage Manager](storage-management.md) for Phase 4 disk topology, I/O and
read-only fixture file browsing.

Network management, centralized Logs, interactive
Terminal, Docker, installed Applications, Databases and Infrastructure navigation
remain separate phases. This change covers Overview, Process Manager, Services and Storage.
