# PRISM Contracts

Smart contracts for the PRISM staking protocol: the PRISM token, the xPRISM ERC4626 vault, the Express deposit/redeem gateway with KYC, an asset registry, and a T+N redemption queue. Contracts are UUPS-upgradeable and built with Hardhat.

Deployed addresses are listed in [`deployed-addresses.md`](./deployed-addresses.md).

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

## Attribution

This project is released under the [MIT License](./LICENSE). While the MIT
License does not require it, if you use this software in your own product or
service, we kindly ask that you include visible attribution to **OpenEden**
(e.g. in your documentation, UI, or credits) and link to
[openeden.com](https://openeden.com/).
