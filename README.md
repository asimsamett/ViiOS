# ViiOS Standalone

**English** | [Türkçe](README.tr.md)

<img src="public/brand/viios-icon-192.png" alt="ViiOS" width="80" height="80">

**Visual Infrastructure Intelligence** — a self-hosted workspace for managing your Windows and Linux servers. Run ViiOS on Windows or Linux, start with an empty workspace, and connect your own servers. No AI account, AI tool, or developer-specific SSH configuration is required.

[Live demo](https://asimsamett.github.io/ViiOS/) · [Releases](https://github.com/asimsamett/ViiOS/releases) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

> **Application language:** the interface is currently Turkish. This English documentation includes the Turkish labels needed to follow the setup steps.

**Noncommercial use:** ViiOS is distributed under [PolyForm Noncommercial 1.0.0](LICENSE.md). You may use, modify, and distribute it for purposes permitted by that license. Commercial use is not granted and requires separate permission from the rights holder. Preserve the license and [NOTICE](NOTICE). Third-party components retain their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md).

## Explore the demo

The [live demo](https://asimsamett.github.io/ViiOS/) uses synthetic Linux and Windows servers, applications, storage measurements, and files. It never connects to real servers or asks for connection credentials.

```sh
npm ci
npm run demo:build
npm run demo:serve
```

Open the address printed in the terminal, normally `http://127.0.0.1:4180/`.

To publish your own preview, select **Settings → Pages → Source: GitHub Actions**, then run **Actions → Publish ViiOS demo to GitHub Pages**. Subsequent pushes to `main` publish the demo automatically. GitHub displays the deployed URL in the Pages settings. See [Demo setup and data isolation](docs/demo.md).

## Quick start

Install **Node.js 22.13+**, download the project, and open its directory.

- **Windows:** run `start.cmd`.
- **Linux:** run `sh start.sh`.
- **Manual setup:** run `npm ci`, `npm run setup`, then `npm start`.

The first setup downloads npm dependencies and Chromium for application previews. Later launches reuse the installation. If Linux browser libraries are missing, run `npx playwright install --with-deps chromium`; installing system packages requires appropriate privileges.

Open **http://127.0.0.1:3180**. Create an administrator password of at least **8 characters**, enter it twice, and then sign in. No setup code is required. Uppercase letters, numbers, and special characters are not mandatory.

## Add a server

1. Open **Servers → Add server** (**Sunucular → Sunucu ekle**) and select **Linux** or **Windows** as the target. This choice is independent of the computer running ViiOS.
2. Enter the IP address or hostname and SSH port. Compare the displayed SSH fingerprint with a value obtained from the server console or administrator, then confirm it.
3. Enter a username and password or SSH private key. Supply a sudo password for Linux if needed.
4. ViiOS tests the connection, installs its bundled helpers, and checks available capabilities. Progress and error reasons are displayed; failed setup can be retried.
5. Select the ready server. Screens show data for that server, and saved records persist across restarts.

The target needs a **reachable SSH service**, valid credentials, and installation privileges. Linux requires root or sudo access. Windows requires OpenSSH Server, SFTP, and an administrator account. An IP address and password alone cannot connect to a machine with SSH disabled. See [Server connections](docs/connections.md) and [Windows target support](docs/windows-support.md).

Linux helpers use `/opt/viios-agent` and store state under `/var/lib/viios-agent`. The Windows helper lives under `C:\ProgramData\ViiOS\agent`. On Linux, missing required dependencies are installed using a supported package manager. Adding a server authorizes installation into these locations and creation of the required helper permissions. Existing applications are not moved or automatically restarted.

## Edit a server connection

In **Servers** (**Sunucular**), select **Edit** (**Düzenle**) to reopen the wizard for a ready, failed, pending, or installing server. You can change its display name, target platform, address, SSH port, username, and authentication method. Follow **Server → Identity → Connection** (**Sunucu → Kimlik → Bağlantı**) and verify the SSH fingerprint again.

**Use saved SSH credentials** (**Kayıtlı SSH kimlik bilgilerini kullan**) preserves the saved password or private key without displaying it. Clear this option to provide replacements. Changing the authentication method requires credentials for the new method. If needed, provide a Linux sudo password for this installation attempt only.

**Save and reconnect** (**Kaydet ve yeniden bağlan**) updates the same record and restarts connection and setup checks. The server ID, data directory, and Dock/desktop layout are preserved. An active installation attempt is stopped first. If another window has changed the connection settings, reopen the current record; installation progress alone does not cause an edit conflict.

## Supported capabilities

| Capability | Linux target | Windows target |
|---|---|---|
| Password/key onboarding and setup progress | Supported | Supported; OpenSSH required |
| Port/application inventory and reports | Supported | Supported |
| CPU, memory, processes, and disks | Supported | Supported; Windows counters |
| Server storage and folder/application usage | Supported | Supported; mounted fixed volumes |
| File browser and basic file operations | Allowed roots | Allowed roots |
| Large uploads and ZIP transfer | Supported | Not supported in this version |
| Service controls | Verified, unprotected services | Verified, explicitly allowed Windows services |
| Git version management | Supported | Not supported in this version |
| Model inventory | Local configuration/service discovery | Local Ollama, when available |
| Custom UAT deployment and model load testing | Not configured in this distribution | Not configured in this distribution |

Folder measurements have time and entry limits; incomplete results are identified. Disk totals come from mounted filesystems. Network drives and storage requiring separate pool accounting are not always included. Other screens remain usable without Chromium. For applications reachable only from the target, an SSH tunnel is opened on the computer running ViiOS; this does not automatically publish applications to browsers on other computers.

## Dock and desktop shortcuts

Open the editor using the **+** buttons on the Dock or desktop, or **Edit desktop** (**Masaüstünü düzenle**) in the ViiOS menu. Add an application, management tool, folder, or `http://` / `https://` URL; rename, reorder, or remove it. Dock and desktop lists are edited separately. **Save** (**Kaydet**) persists the selected server's layout.

Layouts are stored in `servers/<server-id>/desktop-layout.json` in ViiOS's private data directory, rather than only in browser storage. Another browser connected to the same server uses the saved layout. New servers start with their own default layout, and the editor is available for every server.

Use **Export** (**Dışa aktar**) and **Import** (**İçe aktar**) to transfer a layout as JSON between installations or servers. Entries for unavailable applications or capabilities remain visible and editable. **Default** (**Varsayılan**) resets the selected area; save to apply it. The Dock supports up to 32 shortcuts and the desktop up to 16. Existing Start search pins and recent items are separate.

The public source ZIP excludes personal data and settings. Preserve `data/` when updating an installation. Moving that directory transfers server records and layouts together. If you use `DATA_DIR`, preserve that private directory instead.

## Data and access

The Linux **`acl` package is optional**. Missing `getfacl` / `setfacl` commands do not stop setup or trigger package installation. ViiOS manages project access permissions directly through Python. The server wizard explains this, and the server card shows a notice if the commands cannot be verified. This check does not test filesystem ACL support.

If a filesystem does not support ACL operations or rejects permission changes, preparing additional access to some project folders for version management may be unavailable. ViiOS displays an explanatory popup for these errors; monitoring and file operations permitted by existing rights remain available. Installing `acl` alone does not resolve filesystem or permission problems. Updating controller source does not automatically replace helpers on configured servers; the new error codes require installation of updated helpers.

`data/` contains the administrator password hash, encrypted connection credentials, and server records. The encryption key is in the same private directory; back them up together. Windows ACLs and Linux file permissions restrict access. A ViiOS administrator can exercise the management privileges granted to connected servers.

**Do not publish `data/`, `.env`, `outputs/`, logs, or private keys to GitHub.** `.gitignore` and the source packager exclude them. Removing a server record does not uninstall remote helpers or remove applications.

### Prepare a public source archive

Run `python scripts/package-source.py` instead of manually archiving the whole directory. Packaging requires Python 3.9+. Only files explicitly listed in `public-source-files.json` are included. Review new files before adding them. The packager rejects private data, environment settings, keys, logs, local databases, and AI development-tool directories even if listed. Symbolic links, hard-linked files, and Windows junctions are rejected.

The packager checks private-network IP addresses, some key/token formats, and initial inventories that must remain empty. These checks supplement manual review; they cannot detect every secret. Validate without producing an archive with `python scripts/package-source.py --check`. Check the packaging safeguards with `python -m unittest discover -s tests -p test_public_source.py`.

Output is `outputs/releases/ViiOS-Standalone-<version>-public-source-<digest>.zip`. Its `ViiOS-Standalone/` directory contains the public source; the adjacent `.sha256` file contains the archive checksum. `PUBLIC-SOURCE-MANIFEST.json` inside the archive records each file's size and SHA-256 digest. Entries and contents are verified after writing. Existing ZIPs are not updated automatically; use the latest archive produced by the command.

To change the administrator password, run `npm run set-password`, then restart ViiOS. For network access, configure `APP_HOST` using `.env.example`, use an HTTPS reverse proxy, and set `COOKIE_SECURE=true` and the correct `APP_ORIGIN`.

## Docker and development

Optional Docker setup: `docker compose up --build -d`. Create your administrator password in the browser on first launch. Data persists in a named volume, and the default port binding is local. Docker image execution has not been verified in the development environment used for this release.

Run `npm test`, `npm run check`, `npm run lint`, and `npm run build` for validation. For development, run `npm start` in one terminal and `npm run dev` in another; the proxy connects to port 3180. Windows helper tests require PowerShell 5.1, and Linux helper tests require Linux. See the [validation history](docs/validation.md) for earlier checks and their limits.

Project: [asimsamett/ViiOS](https://github.com/asimsamett/ViiOS). Read [LICENSE.md](LICENSE.md) for the terms of use and [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.
