# GitHub Pages demo

**English** | [Türkçe](demo.tr.md)

<!-- docs-nav:start -->
[Home](../README.md) · [Contributing](../CONTRIBUTING.md) · [License](licensing.md) · [Security](../SECURITY.md)

**Demo** · [Server connections](connections.md) · [Windows support](windows-support.md) · [Validation](validation.md) · [Copyright notices](notices.md) · [Third parties](../THIRD_PARTY_NOTICES.md)
<!-- docs-nav:end -->

ViiOS's synthetic-data interface can be published as a static GitHub Pages site. No server, SSH account, password, database, or AI service is required. Opening the page displays an example desktop.

**Publishing is restricted:** The public publishing steps below are only for the Copyright Holder or a person with separate written authorization. The [license](../LICENSE) permits private noncommercial local previews, but does not grant redistribution or third-party hosting rights. The official owner-published demo is not permission to publish another copy.

## Publish on GitHub

1. Extract the clean source package and upload its files to the root of your GitHub repository, including `.github/workflows/demo-pages.yml`.
2. Select **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Run **Actions → Publish ViiOS demo to GitHub Pages → Run workflow**. Later pushes to `main` run the workflow automatically.
4. Open the URL shown in the `github-pages` environment or **Settings → Pages**. Project URLs usually follow `https://<username>.github.io/<repository>/`. Add your own URL to the README.

The workflow uses the base path supplied by Pages; the repository name is not hardcoded. Only generated static demo files are published. The server application, full source directory, and runtime data are not uploaded to Pages. Uploading source files alone does not enable Pages; step 2 is required.

Official guide: [Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Preview locally

With Node.js 22.13+, run these commands in the project directory:

```sh
npm ci
npm run demo:build
npm run demo:serve
```

Open the URL printed in the terminal, normally `http://127.0.0.1:4180/`. This is separate from the real management application's port 3180. The first two commands install dependencies and build the demo; only the last command is needed to serve an existing build.

To test a GitHub project subpath locally, set `VIIOS_DEMO_BASE_PATH=/viios-demo` before building. In PowerShell:

```powershell
$env:VIIOS_DEMO_BASE_PATH = '/viios-demo'
npm run demo:build
npm run demo:serve
```

The URL becomes `http://127.0.0.1:4180/viios-demo/`. Use `VIIOS_DEMO_PORT` to change the preview port.

## What is included?

- Example Linux and Windows servers and application desktops.
- Application/port inventories and application illustrations created for the demo.
- Disk capacity, folder/application usage, and CPU/memory indicators.
- An example file browser, text files, model inventory, and version history.
- Light/dark themes, desktop appearance, and example shortcut layouts.

All names, IP addresses, files, and measurements are synthetic. Application images are illustrations rather than screenshots of real applications. Adding servers, editing connection credentials, saving real passwords, uploading files, controlling services, and running models are disabled. Supported visual layout changes remain in page memory; **Reset demo** (**Demoyu sıfırla**) restores the initial state. Theme preferences may persist in browser storage. The application interface is currently Turkish.

## Data isolation

`demo/fixtures.mjs` generates the example content, and `demo/api.mjs` answers requests in browser memory. There is no fallback that forwards unknown or external requests to a real network. API reads use the demo transport, and file uploads are rejected before any network request is created.

`scripts/build-demo.mjs` copies only files listed in `public-source-files.json` into a temporary build directory. It does not copy `.env`, `data/`, `outputs/`, saved connections, or keys, and it does not forward application settings from the environment. The normal application's `dist/client` output is unchanged. Demo files are generated in the Git-ignored `outputs/demo-site/` directory. The workflow uploads that static directory as its Pages artifact.

Normal `npm run build` and `npm start` commands use the real authenticated management application. Building the demo does not change the local administrator account or saved servers.
