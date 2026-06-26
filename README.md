# PRISM Contracts

Smart contracts for the PRISM staking protocol. Contracts are UUPS-upgradeable and built with Hardhat.

## Contracts

- `Token` — the PRISM token
- `Vault` — the xPRISM ERC4626 staking vault
- `RedemptionQueue` — T+N unstaking queue
- `Express` — deposit/redeem gateway with KYC and limits
- `AssetRegistry` — supported-asset configuration and price feeds
- `MintRedeemLimiter` — per-operation deposit/redeem limits

## Deployed Addresses

Deployed contract addresses for all networks (mainnet + testnet) are in [`deployed-addresses.md`](./deployed-addresses.md).

## Development

```sh
# install dependencies
npm install

# compile contracts
npm run compile

# run tests
npm run test

# format
npm run format
```

## Audits

Independent security audit reports are in [`audits/`](./audits/).

## Attribution

This project is released under the [MIT License](./LICENSE). While the MIT
License does not require it, if you use this software in your own product or
service, we kindly ask that you include visible attribution to **OpenEden**
(e.g. in your documentation, UI, or credits) and link to
[openeden.com](https://openeden.com/).
