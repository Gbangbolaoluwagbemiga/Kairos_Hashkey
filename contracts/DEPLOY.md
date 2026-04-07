# Contracts — Deploy & Register (Four.meme Sprint Testnet)

This folder contains the on-chain primitives that make Kairos auditable and programmable for the Four.meme AI Sprint submission:

- `AgentRegistry.sol` — on-chain registry for the 9 specialists (owner, price, metadata)
- `SpendingPolicy.sol` — optional daily spend limits (demo of programmable spend gates)

## Prerequisites

- Foundry installed (`forge --version`)
- A funded **Sprint testnet** EVM account (same treasury you use in backend is fine)

## 1) Configure env

Copy the example env and fill values.

```bash
cp .env.example .env
```

At minimum set:

- `FOURMEME_RPC_URL`
- `PRIVATE_KEY`

## 2) Deploy

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$FOURMEME_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

You’ll see logs like:

- `AgentRegistry: 0x...`
- `SpendingPolicy: 0x...`

Copy them into:

- `contracts/.env` as `KAIROS_AGENT_REGISTRY` + `KAIROS_SPENDING_POLICY`
- `kairos-backend/.env` as `KAIROS_AGENT_REGISTRY_EVM_ADDRESS` + `KAIROS_SPENDING_POLICY_EVM_ADDRESS`

## 3) Register the 9 agents

Set all `*_OWNER` addresses (payout recipients). For hackathon demos, you can point them all to the same treasury address.

Then run:

```bash
forge script script/RegisterAgents.s.sol:RegisterAgents \
  --rpc-url "$FOURMEME_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

## 4) Quick sanity checks

- Backend RPC health: `GET /api/fourmeme/rpc-health`
- Faucet: `POST /api/fourmeme/faucet` with `{ "address":"0x...", "amount":"0.05" }`
- Marketplace loads: `GET /providers`

