# Validation history

**English** | [Türkçe](validation.tr.md)

These are dated validation records, not a claim that every check has been rerun for the current commit. Test counts, file counts, and limitations describe the revision tested on each date. Current automated results are available in [GitHub Actions](https://github.com/asimsamett/ViiOS/actions).

## October 6, 2026 — Initial GitHub publication

The standalone preview was published with a synthetic-data Pages demo. The [Windows/Linux validation workflow](https://github.com/asimsamett/ViiOS/actions/runs/37422213622) and [Pages deployment workflow](https://github.com/asimsamett/ViiOS/actions/runs/37422213627) both completed successfully. The publication included 292 reviewed source files. The earlier lint errors recorded below were fixed before publication. These results supersede earlier statements that GitHub publication or CI had not yet run.

## October 5, 2026 — Synthetic-data GitHub Pages demo

The static demo was built from an isolated source copy using `/viios-demo/` to simulate a GitHub project subpath. `dist/client` and local administrator/server data were unchanged. The Pages workflow publishes only static demo output. At this stage the GitHub repository/Pages configuration had not yet been supplied, so no live GitHub deployment was performed.

- `npm test`: **175 passed**, 0 failed. Coverage included demo API isolation, static serving, source-copy boundaries, and rejection of file uploads before network requests.
- TypeScript checks and targeted lint for changed frontend/demo files passed.
- The static production build passed. Sixteen HTML asset links containing the base path returned HTTP 200; `index.txt`, `.nojekyll`, and relative webmanifest paths were verified. The demo server had no real API endpoints.
- Packaging validation accepted **282 source files**. Packaging tests had **9 passes** and 1 skip because Windows symbolic-link privileges were unavailable.
- **12/12 browser checks passed**: desktop, applications, storage tabs/folder inspection, model catalog, Linux/Windows switching, a sample text file, themes, and a 390 px mobile layout. Server addition was disabled and no password field was present. Among **112 observed static requests**, there were no real `/api` or external-server requests, failed requests/404s, or browser errors.

## October 5, 2026 — Source sharing without server data

The source package used only the 269 files explicitly listed in `public-source-files.json` at that revision. Local administrator/server records, encryption keys, environment files, outputs, screenshots, backups, and old private sources were excluded. Initial inventories and target configurations had to match generic empty defaults. The ZIP's entry list and every file's contents were verified after packaging.

Remote model-discovery code tied to the old installation's SSH target/service was removed. Local model discovery on the selected server was retained. Old server/project identifiers and internal-network addresses in tests were replaced with synthetic examples.

- `npm test`: **163 passed**, 0 failed.
- Packaging safeguards: **9 passed**, 1 skipped because Windows symbolic-link creation privileges were unavailable. Tests covered rejection of real hard links, exclusion of data/key/environment files, rejection of unknown configuration fields, and ZIP content/hash consistency.
- Python model tests: **20 passed**. A Linux-only model connection module was skipped on Windows. Separate NIM/Ollama tests also passed.
- Source validation: **269 files passed**. Targeted checks found no known old environment identifiers or private-network IP addresses.
- Local accounts and server records were unchanged; no production-server or GitHub deployment occurred at this stage. Existing source ZIPs were not updated; the newly generated `public-source` package was required.

The source scan is not a guarantee that every kind of secret is absent. New manifest entries need manual review. The lint problems recorded below for the first-run change were not fixed as part of this stage.

## October 5, 2026 — First-run setup change

The first-run screen asks only for an administrator password and confirmation. The setup-code field and `VIIOS_SETUP_TOKEN` setting were removed. Passwords require at least 8 characters, with no mandatory uppercase letters, numbers, or special characters. The setup request contains only `password` and `confirmPassword`; users choose their own password.

- Related setup, HTTP, and authentication tests: **6 passed**, 0 failed.
- `npm run check`, `npm run build`, and targeted lint for changed files passed.
- Browser checks confirmed removal of the setup-code field, rejection of 7-character passwords, and acceptance of an 8-digit password and a mixed 9-character password. Requests contained only the two password fields; there were no browser errors. Setup API responses were mocked to avoid replacing the existing administrator record.
- The local application was restarted at `http://127.0.0.1:3180`; its HTTP response and setup state were verified.
- Full `npm run lint` failed on 3 existing errors in `server/connection-routes.mjs` and `app/desktop-layout.ts`, which were not changed during this stage.

## October 2, 2026 — Historical baseline

The standalone copy was validated on Windows. No deployment was made to the existing ViiOS installation or a production server.

### Passed checks

- `npm test`: **157/157 passed**, including initial administrator setup, real HTTP session/CSRF checks, an empty server list, target isolation, and existing application behavior.
- Connection subset: **15 tests**, using a real local SSH2 server for password/encrypted-key authentication, fingerprint checks, rejection of wrong host keys before authentication, JSON standard input, fixed Windows/Linux command mapping, SSH tunnels, encrypted records, queuing, and cancellation/removal.
- `npm run check`, `npm run lint`, and `npm run build` passed. The build used Node 22.23.2 and retained only an informational bundle-size notice.
- `npm audit` reported **0 vulnerabilities** across dependencies at that time. This was not a comprehensive security audit.
- Browser checks covered setup/login, the empty workspace, Linux/Windows options, fingerprint confirmation, password/key forms, setup/error/retry/removal, switching to ready targets, Windows virtual paths, and capability limitations on desktop/mobile and in light/dark themes. Synthetic API data was used; no browser exceptions occurred.
- Windows tests ran in PowerShell 5.1 and 7, covering file limits, junction/hard-link and stale-revision rejection, JSON responses, allowed service controls, and bounded local HTTP discovery. Real Windows resource and disk measurements were exercised read-only.
- Windows responses were also exercised through the existing Node controllers: file list/create/read/download and 409 errors, resource measurements, storage overview and bounded usage, model inventory, and unsupported concurrency responses. **13 local helper calls passed.** The SSH execution boundary was redirected to local PowerShell; no real remote server was used.
- Linux helpers: 11 Python files and the generated setup script passed syntax checks. Port parsing had 3 passing unit tests, and resource accounting had 7.

### Not yet verified at that stage

Complete onboarding was not run end to end against a fresh remote Linux or Windows server. Linux package managers, real sudo/SFTP environments, Windows OpenSSH administrator sessions, and distribution-specific behavior still required target integration checks. Setup scenarios used a fake remote executor.

Docker and a Linux runtime were unavailable on the development computer, so the Docker image and the full Linux file/Git test suites were not run locally. The GitHub Actions file included a Windows/Linux matrix, but it had not yet run because the repository had not been published at that stage.

Windows Git management, large-file streaming/ZIP transfer, and custom UAT flows were outside the release's support scope. See [README](../README.md), [Server connections](connections.md), and [Windows target support](windows-support.md).
