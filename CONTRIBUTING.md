# Contributing to ViiOS

**English** | [Türkçe](CONTRIBUTING.tr.md)

Use [Issues](https://github.com/asimsamett/ViiOS/issues) for bug reports and feature suggestions, and pull requests for code changes. The project is distributed under [PolyForm Noncommercial 1.0.0](LICENSE.md); contributions must be submitted under the same project license. Preserve the license and copyright notices of third-party code.

## Development

You need Node.js 22.13+ and Python 3.9+ for packaging checks.

```sh
npm ci
npm test
npm run check
npm run lint
npm run build
python scripts/package-source.py --check
python -m unittest discover -s tests -p test_public_source.py
```

Use `npm run demo:build` and `npm run demo:serve` to explore the interface without connecting a real server. The README explains differences between Linux and Windows target support.

## Submit a change

1. Use a separate branch and focus the change on one issue.
2. Explain how to reproduce the problem, the expected behavior, and the checks you ran.
3. Review new public source files before adding them to `public-source-files.json`.
4. Open a pull request and confirm that automated checks pass.

Do not include real server addresses, account information, passwords, keys, inventories, logs, or customer data in issues, screenshots, or commits. Use documentation addresses and synthetic examples. `data/`, `.env`, `outputs/`, and development-tool sessions are excluded from the public source package.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Documentation languages

The default README and documentation are English. Turkish counterparts use the `.tr.md` suffix and link back to the English version. Keep both aligned when changing setup instructions or supported behavior. The application interface is currently Turkish; include its displayed Turkish label when translating UI instructions.
