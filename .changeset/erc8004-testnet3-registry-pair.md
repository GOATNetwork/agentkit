---
'@goatnetwork/agentkit': patch
---

Correct the GOAT Testnet3 (`goat-testnet`, chain 48816) ERC-8004 registry pairing.
The default Identity Registry changes from `0x556089008Fc0a60cD09390Eca93477ca254A5522`
(used in versions 0.1.2–0.2.3) to `0x54B8d8E2455946f2A5B8982283f2359812e815ce`,
the Identity Registry paired with the unchanged Reputation Registry
`0xd9140951d8aE6E5F625a02F5908535e16e3af964`. Mainnet addresses, ABIs and action arguments are unchanged.

Existing registrations are not migrated. An agentId is scoped to its registry:
the same number in the new registry may identify another agent or no agent.
Do not reuse an old agentId for feedback or metadata operations through the updated
defaults. Keep old registrations associated with their original registry, and
register in the new registry to obtain the agentId for the corrected pair.
New registration files must use
`eip155:48816:0x54B8d8E2455946f2A5B8982283f2359812e815ce` as `agentRegistry`.
