# GOAT Compliance Plugin

x402 payment validation + ERC-8004 agent identity compliance plugin for [GOAT Network agentkit](https://github.com/GOATNetwork/agentkit).

## Actions

- **validateX402Payment** — Pre-flight checks on x402 payment requests (address, amount, network, asset, merchant security)
- **validateX402Response** — Validate HTTP 402 response spec compliance (status, headers, body, challenge markers, payment info)
- **checkAgentIdentity** — Verify ERC-8004 agent registration + reputation before transacting

## Why

Agents need to verify who they're paying and that the payment will work before sending money. This plugin gives GOAT agents compliance-grade payment validation out of the box.

Built by [GenTech Labs](https://gentechlabs.net) — agent economy infrastructure.
