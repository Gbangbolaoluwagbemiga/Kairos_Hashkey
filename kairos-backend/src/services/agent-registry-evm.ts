import { ethers } from "ethers";

export interface AgentMetadataEvm {
    key: string; // agent string key: "oracle"
    owner: string; // EVM address
    name: string;
    serviceType: string;
    priceWei: bigint;
    reputation: number;
    tasksCompleted: number;
    active: boolean;
}

const AGENT_REGISTRY_ABI = [
    "function getAgent(bytes32 key) view returns (tuple(bytes32 key,address owner,string name,string serviceType,uint256 priceWei,uint32 reputation,uint32 tasksCompleted,bool active))",
];

const FALLBACK_AGENT_OWNERS: Record<string, string | undefined> = {
    oracle: process.env.ORACLE_EVM_ADDRESS,
    news: process.env.NEWS_EVM_ADDRESS,
    yield: process.env.YIELD_EVM_ADDRESS,
    tokenomics: process.env.TOKENOMICS_EVM_ADDRESS,
    perp: process.env.PERP_EVM_ADDRESS,
    "chain-scout": process.env.CHAIN_SCOUT_EVM_ADDRESS,
    protocol: process.env.PROTOCOL_EVM_ADDRESS,
    bridges: process.env.BRIDGES_EVM_ADDRESS,
    "dex-volumes": process.env.DEX_VOLUMES_EVM_ADDRESS,
};

function toKeyBytes32(agentKey: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(agentKey));
}

function mustAddr(a: string | undefined, label: string): string {
    if (!a) throw new Error(`Missing ${label}`);
    if (!ethers.isAddress(a)) throw new Error(`Invalid address for ${label}: ${a}`);
    return a;
}

/**
 * Resolve agent metadata from EVM registry; falls back to env-based mapping.
 */
export async function resolveAgentEvm(args: {
    rpcUrl: string;
    chainId?: number;
    registryAddress?: string;
    agentKey: string;
}): Promise<AgentMetadataEvm | undefined> {
    const agentKey = args.agentKey;
    const ownerFallback = FALLBACK_AGENT_OWNERS[agentKey];

    // If no registry configured, use fallback addresses with a default price.
    if (!args.registryAddress) {
        if (!ownerFallback) return undefined;
        return {
            key: agentKey,
            owner: mustAddr(ownerFallback, `${agentKey.toUpperCase()}_EVM_ADDRESS`),
            name: agentKey,
            serviceType: agentKey,
            priceWei: ethers.parseEther(process.env.KAIROS_DEFAULT_AGENT_PRICE_BNB || "0.001"),
            reputation: 100,
            tasksCompleted: 0,
            active: true,
        };
    }

    const provider = new ethers.JsonRpcProvider(args.rpcUrl, args.chainId);
    const registry = new ethers.Contract(args.registryAddress, AGENT_REGISTRY_ABI, provider);

    try {
        const key = toKeyBytes32(agentKey);
        const a = await registry.getAgent(key);
        const policyAddr = (process.env.KAIROS_SPENDING_POLICY_EVM_ADDRESS || "").trim().toLowerCase();
        const regOwner = String(a.owner || "").toLowerCase();
        // Misconfigured registries sometimes point agent.owner at the spending-policy contract.
        // Native payouts must go to an EOA/agent wallet, not the policy contract.
        if (policyAddr && regOwner && regOwner === policyAddr && ownerFallback) {
            console.warn(
                `[RegistryEVM] ${agentKey}: on-chain owner matches KAIROS_SPENDING_POLICY_EVM_ADDRESS; using ${agentKey.toUpperCase()}_EVM_ADDRESS fallback`
            );
            return {
                key: agentKey,
                owner: mustAddr(ownerFallback, `${agentKey.toUpperCase()}_EVM_ADDRESS`),
                name: agentKey,
                serviceType: agentKey,
                priceWei: BigInt(a.priceWei),
                reputation: Number(a.reputation),
                tasksCompleted: Number(a.tasksCompleted),
                active: Boolean(a.active),
            };
        }
        return {
            key: agentKey,
            owner: String(a.owner),
            name: String(a.name),
            serviceType: String(a.serviceType),
            priceWei: BigInt(a.priceWei),
            reputation: Number(a.reputation),
            tasksCompleted: Number(a.tasksCompleted),
            active: Boolean(a.active),
        };
    } catch (e) {
        // fallback if registry missing entry
        if (ownerFallback) {
            return {
                key: agentKey,
                owner: mustAddr(ownerFallback, `${agentKey.toUpperCase()}_EVM_ADDRESS`),
                name: agentKey,
                serviceType: agentKey,
                priceWei: ethers.parseEther(process.env.KAIROS_DEFAULT_AGENT_PRICE_BNB || "0.001"),
                reputation: 100,
                tasksCompleted: 0,
                active: true,
            };
        }
        console.warn(`[RegistryEVM] resolve failed for ${agentKey}:`, (e as Error)?.message);
        return undefined;
    }
}

