# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PRISM is a regulated yield-bearing token system built with OpenZeppelin v5.x upgradeable contracts on Hardhat. The system consists of core contracts and extension modules:

**Core Contracts:**
1. **PRISM** - Upgradeable ERC-20 token with regulatory controls (ban list, pausability, issue cap)
2. **PRISMVault** - ERC-4626 vault for staking PRISM with flash loan protection and inflation attack protection
3. **RedemptionQueue** - Time-delayed redemption queue (T+N configurable) for regulatory compliance

**Extension Contracts:**
4. **PRISMExpress** - Mint and redemption gateway for instant minting with underlying assets (USDO) and queued redemptions
5. **AssetRegistry** - Asset management and conversion registry
6. **PRISMMintRedeemLimiter** - Rate limiting and minimum deposit requirements
7. **PRISMExpressPausable** - Separate pause controls for mint and redeem operations

## Development Commands

### Building & Compiling

```bash
npm run compile        # Compile all contracts
npm run clean          # Clean artifacts and cache
npm run typechain      # Generate TypeChain types
```

### Testing

```bash
npm test                    # Run all tests
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests
npm run test:vault          # PRISMVault tests only
npm run test:queue          # Redemption queue tests only
npm run test:fuzz           # Fuzz tests
npm run test:invariants     # Invariant tests
```

### Single Test Commands

```bash
npx hardhat test --grep "test name"                    # Run specific test
npx hardhat test test/unit/PRISMVault.test.ts         # Run specific file
npx hardhat test --show-stack-traces                   # Show full stack traces
npx hardhat test --verbose                             # Verbose output
npx hardhat test --timeout 60000                       # Increase timeout
```

### Coverage & Gas Analysis

```bash
npm run coverage            # Full coverage report (opens coverage/index.html)
npm run coverage:unit       # Unit test coverage only
npm run gas-report          # Gas usage report (saves to gas-report.txt)
REPORT_GAS=true npm test   # Enable gas reporting for tests
```

### Code Formatting

```bash
npm run format              # Format contracts and tests
npm run format:check        # Check formatting without writing
```

### Local Development Network

```bash
npm run node                    # Start local Hardhat node
npm run deploy:local            # Deploy to local network
npm run deploy:sepolia          # Deploy to Sepolia testnet
```

## Core Contract Architecture

### Contract Inheritance Hierarchy

**PRISM (Token)**

```
Initializable
├── ERC20Upgradeable
├── ERC20PausableUpgradeable
├── AccessControlEnumerableUpgradeable
└── UUPSUpgradeable
```

**PRISMVault (Staking)**

```
Initializable
├── ERC20Upgradeable
├── ERC20PausableUpgradeable
├── ERC4626Upgradeable
├── AccessControlEnumerableUpgradeable
└── UUPSUpgradeable
```

**RedemptionQueue**

```
Initializable
├── AccessControlEnumerableUpgradeable
└── UUPSUpgradeable
```

**PRISMExpress (Mint/Redeem Gateway)**

```
Initializable
├── UUPSUpgradeable
├── AccessControlEnumerableUpgradeable
├── PRISMExpressPausable
└── PRISMMintRedeemLimiter
```

### Key Roles

All contracts use OpenZeppelin AccessControlEnumerable with these roles:

**PRISM Token:**
- `DEFAULT_ADMIN_ROLE` - Full administrative control
- `MINTER_ROLE` - Can mint PRISM tokens
- `BURNER_ROLE` - Can burn PRISM tokens
- `PAUSE_ROLE` - Can pause/unpause token transfers
- `BANLIST_ROLE` - Can ban/unban addresses
- `UPGRADE_ROLE` - Can upgrade contract implementations

**PRISMVault:**
- `DEFAULT_ADMIN_ROLE` - Full administrative control
- `PAUSE_ROLE` - Can pause/unpause vault operations
- `UPGRADE_ROLE` - Can upgrade contract implementations

**RedemptionQueue:**
- `DEFAULT_ADMIN_ROLE` - Full administrative control and emergency functions
- `UPGRADE_ROLE` - Can upgrade contract implementations

**PRISMExpress:**
- `DEFAULT_ADMIN_ROLE` - Full administrative control
- `PAUSE_ROLE` - Can pause/unpause mint and redeem operations
- `WHITELIST_ROLE` - Can manage KYC whitelist
- `MAINTAINER_ROLE` - Can update configuration parameters
- `OPERATOR_ROLE` - Can process redemption queue and manage liquidity
- `UPGRADE_ROLE` - Can upgrade contract implementations

### Core Data Flow

**Via PRISMExpress (Primary User Flow):**
1. **Instant Mint**: User deposits USDO → PRISMExpress mints PRISM to user (requires KYC, first deposit minimum)
2. **Staking**: User stakes PRISM in vault → Receive xPRISM share tokens → PRISM locked in vault
3. **Unstaking**: User unstakes xPRISM shares → Shares burned → PRISM sent to redemption queue
4. **Redemption Claim**: After T+N delay → User claims PRISM from queue
5. **Redeem Request**: User requests redemption via PRISMExpress → PRISM burned → USDO returned after processing

**Direct Minting (Admin Only):**
- Admin with MINTER_ROLE can mint PRISM directly to addresses (bypasses KYC checks)

### Critical Security Features

**PRISM Token**

- Ban list: Prevents sanctioned addresses from transferring (enforced on all transfers, including mints and burns)
- Issue cap: Maximum token supply limit (0 = unlimited)
- Pausability: Emergency stop for all transfers
- Batch operations: Gas-efficient ban/unban multiple addresses
- Role-based access control: Separate roles for minting, burning, banning, and pausing

**PRISMVault**

- Flash loan protection: Same-block stake/unstake prevention via `lastActionBlock` mapping
- Ban list inheritance: Inherits ban checks from underlying PRISM token
- Disabled standard ERC-4626 functions (use `stake`/`unstake` instead)
- Integration with redemption queue (no direct withdrawals)
- Dual pause mechanism: Both vault-level and PRISM token-level pausing

**RedemptionQueue**

- T+N processing delay (configurable, default 7 days)
- User-initiated claims (no automatic processing)
- Emergency withdraw function for admin
- Vault-only enqueue access

**PRISMExpress**

- KYC enforcement: All mints and redemptions require KYC for both sender and receiver
- First deposit requirements: Higher minimum for first-time depositors
- Separate pausability: Independent pause controls for mints and redemptions
- Fee management: Configurable mint and redeem fees (in basis points)
- Rate limiting: Minimum amounts for mints and redemptions
- Asset registry integration: Multi-asset support with price conversions

## Testing Philosophy

### Test Organization

- **Unit tests** (`test/unit/`): Test individual contract functions in isolation
- **Integration tests** (`test/integration/`): Test cross-contract interactions
- **Fuzz tests** (`test/unit/FuzzTests.test.ts`): Random input testing
- **Invariant tests** (`test/unit/Invariants.test.ts`): System-wide properties that must always hold

### Coverage Targets

- Line coverage: >95%
- Branch coverage: >90%
- Function coverage: 100%
- All security-critical paths: 100%

### Test Patterns

```typescript
// 1. Use fixtures for efficient test setup
const { prism, vault, queue, users } = await loadFixture(deployCoreContracts);

// 2. Test custom errors
await expect(prism.connect(user1).mint(user2.address, amount)).to.be.revertedWithCustomError(
  prism,
  'AccessControlUnauthorizedAccount'
);

// 3. Test events
await expect(prism.connect(minter).mint(user1.address, amount))
  .to.emit(prism, 'Mint')
  .withArgs(user1.address, amount);

// 4. Time manipulation
await time.increase(7 * 24 * 60 * 60); // Fast-forward 7 days

// 5. State verification
const before = await prism.balanceOf(user1.address);
await prism.connect(minter).mint(user1.address, amount);
expect(await prism.balanceOf(user1.address)).to.equal(before + amount);
```

## OpenZeppelin v5.x Specifics

### Initialization Pattern

```solidity
/// @custom:oz-upgrades-unsafe-allow constructor
constructor() {
    _disableInitializers();
}

function initialize(...) public initializer {
    __ERC20_init(name, symbol);
    __ERC20Pausable_init();
    __AccessControl_init();
    __UUPSUpgradeable_init();
    // Grant initial roles
}
```

### UUPS Upgrade Authorization

```solidity
function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADE_ROLE) {}
```

### ERC-4626 Custom Override

```solidity
// Vault disables standard functions and uses stake/unstake instead
function deposit(uint256, address) public pure override returns (uint256) {
  revert UseStakeInstead();
}

function withdraw(uint256, address, address) public pure override returns (uint256) {
  revert UseUnstakeInstead();
}
```

## Smart Contract Development Guidelines

### When Adding New Features

1. Start with tests (TDD approach - see constitution principle II)
2. Add custom errors instead of revert strings
3. Emit events for all state changes
4. Use existing roles or create new role constants
5. Add access control modifiers to admin functions
6. Consider pause functionality for user-facing operations
7. Update test coverage to maintain >95%

### When Modifying Existing Contracts

1. Check storage layout compatibility (for upgrades)
2. Never reorder or remove state variables
3. Only append new state variables
4. Update all affected tests
5. Run full test suite including invariant tests
6. Check gas impact with `npm run gas-report`

### Code Style

- Follow Solidity 0.8.20 conventions
- Use custom errors over revert strings (gas efficient)
- Document complex logic with NatSpec comments
- Use descriptive variable names
- Group related functions together
- Keep functions under 50 lines when possible
- Use AccessControlEnumerable for role management (allows enumeration of role members)

### Security Checklist

- [ ] Access control on admin functions
- [ ] Input validation (zero address, zero amount)
- [ ] Reentrancy protection (inherited from OpenZeppelin)
- [ ] Integer overflow protection (Solidity 0.8.x default)
- [ ] Event emission for state changes
- [ ] Pausability for emergency stops
- [ ] Test edge cases (max values, zero, dust amounts)

## Key Implementation Details

### Issue Cap Behavior

- When `issueCap == 0`: Unlimited minting allowed
- When `issueCap > 0`: Total supply cannot exceed cap
- Cap cannot be set below current supply

### Flash Loan Protection

PRISMVault implements flash loan protection:

- Tracks `lastActionBlock` per user
- Prevents stake and unstake in the same block
- Protects against flash loan attacks and price manipulation

### Redemption Queue Process (Vault)

1. User calls `vault.unstake(shares)` → shares burned, PRISM sent to queue
2. Queue creates redemption with `claimableAt = block.timestamp + delay`
3. After delay, user calls `queue.claim(redemptionId)` → PRISM transferred to user
4. Admin can emergency withdraw from queue if needed

### PRISMExpress Redemption Queue

Separate from vault redemption queue:
1. User calls `express.redeemRequest(to, amount)` → PRISM held in contract, added to queue
2. Operator processes queue via `processRedemptionQueue(len)`
3. PRISM burned, USDO transferred to user (minus fees)
4. Admin can cancel requests and refund PRISM if needed

### Ban List Enforcement

- Banned addresses CANNOT transfer PRISM (send or receive)
- Ban checks apply to ALL PRISM operations including mints and burns (regulatory compliance)
- Banned addresses CANNOT stake or receive vault shares
- Ban list applies to both PRISM transfers and xPRISM share transfers
- PRISMExpress requires KYC (separate from ban list) for mints and redemptions

### PRISMExpress Features

**Instant Minting:**
- Users deposit underlying assets (USDO) and instantly receive PRISM
- Asset conversion handled by AssetRegistry
- Fees deducted and sent to `feeTo` address
- Net assets sent to `treasury`
- KYC required for both sender and receiver
- First deposit amount requirement enforced

**Queued Redemption:**
- Users request redemption of PRISM for USDO
- PRISM held in contract, user info tracked in queue
- Operator processes queue when liquidity available
- PRISM burned, USDO transferred to user (minus fees)
- Queue processing can be cancelled by maintainer with PRISM refund

**Fee Structure:**
- Mint fee: Configurable in basis points (1e4 = 100%)
- Redeem fee: Configurable in basis points
- Fees sent to `feeTo` address

**Rate Limiting:**
- Mint minimum: Prevents dust mints
- First deposit amount: Higher requirement for new users (anti-sybil)
- Redeem minimum: Prevents dust redemptions

**Asset Management:**
- Multi-asset support via AssetRegistry
- Off-ramp function to move USDO to treasury
- Liquidity tracking for redemption processing

## Project-Specific Conventions

### Test Fixture Pattern

All tests use `deployments.ts` fixture:

```typescript
export async function deployCoreContracts() {
  // Returns { prism, vault, queue, deployer, users: [user1, user2, ...] }
}
```

### Role Naming

- Roles use ALL_CAPS with underscores: `MINTER_ROLE`, `PAUSE_ROLE`
- Role constants are public for external visibility
- Use `keccak256("ROLE_NAME")` for role IDs

### Error Naming

- Custom errors use PascalCase: `InvalidAddress`, `InsufficientBalance`
- Errors defined at contract level, not in interfaces
- Descriptive names preferred over generic `Error` suffix

### Event Naming

- Events use PascalCase: `Mint`, `Burn`, `Stake`, `Unstake`
- Past tense for state changes: `Minted`, `Burned`
- Include indexed parameters for off-chain filtering

## Constitution Principles

The project follows strict quality standards defined in `.specify/memory/constitution.md`:

1. **Code Quality Standards**: All code must pass static analysis, maintain >80% coverage for critical paths
2. **Test-First Development**: No implementation without failing tests first
3. **User Experience Consistency**: Predictable response times, helpful error messages
4. **Performance Requirements**: Defined latency budgets, automated benchmarks

## Additional Resources

- **Project Index**: See [PROJECT_INDEX.md](PROJECT_INDEX.md) for complete project structure and file organization
- **Attack Calculations**: See [attack_calculation.md](attack_calculation.md) for inflation attack analysis
- **README**: See [README.md](README.md) for project overview and setup

## Environment Setup

### Required Environment Variables

Create `.env` file (see `.env.example`):

```bash
SEPOLIA_RPC_URL=
MAINNET_RPC_URL=
PRIVATE_KEY=
ETHERSCAN_API_KEY=
COINMARKETCAP_API_KEY=  # For gas-reporter USD pricing
```

### Recommended Tools

- Hardhat v2.27.1+
- Node.js v18+
- OpenZeppelin Contracts v5.4.0
- TypeScript v5.9.3+

## Pre-commit Hooks

The project uses Husky for automatic code formatting:

- Runs Prettier on all `.sol`, `.ts`, `.js` files before commit
- Configured via `.husky/pre-commit` hook
- Format manually with `npm run format`

## Notes for Future Development

### When Adding New Contracts

1. Follow the three-tier structure: core/, extension/, oracle/
2. Implement initialization pattern with `_disableInitializers()`
3. Add comprehensive unit tests (aim for 100+ tests per contract)
4. Add integration tests for cross-contract interactions
5. Document in this file under "Core Contract Architecture"

### When Upgrading Contracts

1. Use `@openzeppelin/hardhat-upgrades` plugin
2. Validate storage layout with `upgrades.validateUpgrade()`
3. Test upgrade process in tests
4. Never modify existing storage variable order
5. Only append new state variables at the end
6. Maintain storage gaps (`__gap` arrays) for future upgrades

### When Integrating Price Feeds

1. Implement circuit breakers for price feed failures
2. Validate staleness, round completeness, positive prices
3. Use IPriceFeed interface from `contracts/interfaces/`
4. Integrate with AssetRegistry for asset conversions
