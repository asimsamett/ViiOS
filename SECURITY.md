# Security policy

**English** | [Türkçe](SECURITY.tr.md)

Security fixes target the latest published ViiOS release. No separate maintenance schedule is promised for older releases.

## Report a vulnerability

Submit a private report through **Security → Report a vulnerability** in the repository. If that option is unavailable, open an issue requesting a private contact channel without disclosing sensitive details.

Include the affected version, expected and actual behavior, impact, and reproduction steps using entirely synthetic data where possible. Do not include real server IP addresses, passwords, private keys, session information, or user data. Do not publish vulnerability details or working exploits in public issues.

## Deployment

ViiOS can perform administrative operations on connected servers. Under the standard license, restrict your installation to yourself in a private noncommercial environment; organizational or shared access requires separate written permission. Never publish the `data/` directory or private configuration. Use HTTPS and appropriate access controls for network access. The GitHub Pages demo uses only synthetic data and never connects to real servers.
