# Contributing to ViiOS

**English** | [Türkçe](CONTRIBUTING.tr.md)

<!-- docs-nav:start -->
[Home](README.md) · **Contributing** · [License](docs/licensing.md) · [Security](SECURITY.md)

[Demo](docs/demo.md) · [Server connections](docs/connections.md) · [Windows support](docs/windows-support.md) · [Validation](docs/validation.md) · [Copyright notices](docs/notices.md) · [Third parties](THIRD_PARTY_NOTICES.md)
<!-- docs-nav:end -->

Use [Issues](https://github.com/asimsamett/ViiOS/issues) for factual bug reports and feature suggestions without protected Software code. The project uses the [ViiOS Private Noncommercial License 1.0](LICENSE): private modification is permitted, but publishing changes or transferring code is not generally permitted. Obtain separate written contribution and publication permission before creating a public patch, fork, or pull request; independently existing platform rights are explained in [licensing notes](docs/licensing.md). Preserve third-party notices.

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

## Propose a change

1. Describe the issue and desired behavior without uploading Software code.
2. For a code contribution, request a private contact channel and separate written terms from the Copyright Holder first.
3. Until permission is granted, keep your changes in your private local environment; do not publish or send patches.
4. If permission is granted, use only the transfer/publication scope it authorizes. No automatic copyright assignment or general redistribution license is implied.

Do not include real server addresses, account information, passwords, keys, inventories, logs, or customer data in issues, screenshots, or commits. Use documentation addresses and synthetic examples. `data/`, `.env`, `outputs/`, and development-tool sessions are excluded from the public source package.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Documentation languages

The default README and documentation are English. Turkish counterparts use the `.tr.md` suffix and link back to the English version. Keep both aligned when changing setup instructions or supported behavior. The application interface is currently Turkish; include its displayed Turkish label when translating UI instructions.
