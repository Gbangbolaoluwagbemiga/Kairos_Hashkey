/**
 * DeFiLlama Service - DEX Volume Data
 * Free API, no key required
 * Docs: https://defillama.com/docs/api
 */

const DEFILLAMA_BASE_URL = "https://api.llama.fi";

export interface DexVolumeData {
    protocol: string;
    volume24h: number;
    volume7d: number;
    change24h: number;
}

export interface ChainDexVolume {
    chain: string;
    totalVolume24h: number;
    dexes: DexVolumeData[];
}

/**
 * Get DEX volume overview for all chains
 */
export async function getDexVolumeOverview(): Promise<ChainDexVolume[] | null> {
    try {
        const response = await fetch(`${DEFILLAMA_BASE_URL}/overview/dexs`);
        if (!response.ok) {
            throw new Error(`DeFiLlama API error: ${response.status}`);
        }

        const data = await response.json();

        // Parse the protocols into a cleaner format
        const chainMap = new Map<string, ChainDexVolume>();

        for (const protocol of data.protocols || []) {
            const chain = protocol.chain || "Multi-chain";

            if (!chainMap.has(chain)) {
                chainMap.set(chain, {
                    chain,
                    totalVolume24h: 0,
                    dexes: []
                });
            }

            const chainData = chainMap.get(chain)!;
            const volume24h = protocol.total24h || 0;

            chainData.totalVolume24h += volume24h;
            chainData.dexes.push({
                protocol: protocol.name || protocol.displayName || "Unknown",
                volume24h,
                volume7d: protocol.total7d || 0,
                change24h: protocol.change_1d || 0
            });
        }

        // Sort by volume and return top chains
        return Array.from(chainMap.values())
            .sort((a, b) => b.totalVolume24h - a.totalVolume24h)
            .slice(0, 10);

    } catch (error) {
        console.error("[DeFiLlama] Error fetching DEX volume:", error);
        return null;
    }
}

/**
 * Get DEX volume for a specific chain
 */
export async function getDexVolumeByChain(chain: string): Promise<ChainDexVolume | null> {
    try {
        const chainLower = chain.toLowerCase();
        const response = await fetch(`${DEFILLAMA_BASE_URL}/overview/dexs/${chainLower}`);

        if (!response.ok) {
            throw new Error(`DeFiLlama API error: ${response.status}`);
        }

        const data = await response.json();

        let totalVolume24h = 0;
        const dexes: DexVolumeData[] = [];

        for (const protocol of data.protocols || []) {
            const volume24h = protocol.total24h || 0;
            totalVolume24h += volume24h;

            dexes.push({
                protocol: protocol.name || protocol.displayName || "Unknown",
                volume24h,
                volume7d: protocol.total7d || 0,
                change24h: protocol.change_1d || 0
            });
        }

        // Sort by volume
        dexes.sort((a, b) => b.volume24h - a.volume24h);

        return {
            chain: chainLower,
            totalVolume24h,
            dexes: dexes.slice(0, 10) // Top 10 DEXs
        };

    } catch (error) {
        console.error(`[DeFiLlama] Error fetching DEX volume for ${chain}:`, error);
        return null;
    }
}

/**
 * Get TVL (Total Value Locked) for a protocol
 */
export async function getProtocolTVL(protocol: string): Promise<{ name: string; tvl: number; chain: string } | null> {
    try {
        const response = await fetch(`${DEFILLAMA_BASE_URL}/protocol/${protocol.toLowerCase()}`);

        if (!response.ok) {
            throw new Error(`DeFiLlama API error: ${response.status}`);
        }

        const data = await response.json();

        return {
            name: data.name || protocol,
            tvl: data.tvl || 0,
            chain: data.chain || "Multi-chain"
        };

    } catch (error) {
        console.error(`[DeFiLlama] Error fetching TVL for ${protocol}:`, error);
        return null;
    }
}

/**
 * Get all chains TVL ranking
 */
export async function getChainsTVL(): Promise<{ chain: string; tvl: number }[] | null> {
    try {
        const response = await fetch(`${DEFILLAMA_BASE_URL}/v2/chains`);

        if (!response.ok) {
            throw new Error(`DeFiLlama API error: ${response.status}`);
        }

        const data = await response.json();

        return data
            .map((chain: any) => ({
                chain: chain.name,
                tvl: chain.tvl || 0
            }))
            .sort((a: any, b: any) => b.tvl - a.tvl)
            .slice(0, 15);

    } catch (error) {
        console.error("[DeFiLlama] Error fetching chains TVL:", error);
        return null;
    }
}

// ============================================================
// Protocol Analytics
// ============================================================

export interface ProtocolStats {
    name: string;
    slug: string;
    category: string;
    chains: string[];
    tvl: number;
    tvlChange24h?: number;
    fees24h?: number;
    fees7d?: number;
    fees30d?: number;
    revenue24h?: number;
    revenue7d?: number;
    volume24h?: number;
    description?: string;
    url?: string;
    twitter?: string;
    mcap?: number;
    symbol?: string;
}

/**
 * Get detailed protocol stats (TVL, fees, revenue)
 */


/**
 * Helper to fetch category from a child protocol if the parent is missing it
 */
async function fetchCategoryFromChild(childSlug: string): Promise<string | null> {
    try {
        const slug = childSlug.toLowerCase().replace(/\s+/g, '-');
        const response = await fetch(`${DEFILLAMA_BASE_URL}/protocol/${slug}`);
        if (!response.ok) return null;

        const data = await response.json();
        return data.category || null;
    } catch {
        return null;
    }
}

export async function getProtocolStats(protocol: string): Promise<ProtocolStats | null> {
    try {
        // Map common protocol names to their DeFiLlama slugs
        const slugMap: Record<string, string> = {
            'compound': 'compound-v3',
            'aave': 'aave',
            'uniswap': 'uniswap',
            'curve': 'curve-dex',
            'lido': 'lido',
            'makerdao': 'makerdao',
            'maker': 'makerdao',
            'pancakeswap': 'pancakeswap-amm',
            'sushi': 'sushiswap',
            'sushiswap': 'sushiswap',
            'gmx': 'gmx',
            'balancer': 'balancer-v2',
            'convex': 'convex-finance',
            'yearn': 'yearn-finance',
            'instadapp': 'instadapp',
            'rocket pool': 'rocket-pool',
            'eigenlayer': 'eigenlayer',
            'pendle': 'pendle',
            'morpho': 'morpho',
            'spark': 'spark',
            'sky': 'sky',
        };

        const normalizedInput = protocol.toLowerCase().trim();
        const slug = slugMap[normalizedInput] || normalizedInput.replace(/\s+/g, '-');

        // Fetch protocol data, fees, and revenue in parallel
        const [protocolRes, feesRes, revenueRes] = await Promise.all([
            fetch(`${DEFILLAMA_BASE_URL}/protocol/${slug}`),
            fetch(`${DEFILLAMA_BASE_URL}/summary/fees/${slug}?dataType=dailyFees`).catch(() => null),
            fetch(`${DEFILLAMA_BASE_URL}/summary/fees/${slug}?dataType=dailyRevenue`).catch(() => null)
        ]);

        if (!protocolRes.ok) {
            throw new Error(`Protocol not found: ${protocol}`);
        }

        const protocolData = await protocolRes.json();
        let feesData: any = null;
        let revenueData: any = null;

        if (feesRes && feesRes.ok) {
            feesData = await feesRes.json();
        }
        if (revenueRes && revenueRes.ok) {
            revenueData = await revenueRes.json();
        }

        // --- Category Fallback Logic ---
        let category = protocolData.category;

        // If category is missing/unknown and there are other (child) protocols found
        if ((!category || category === "Unknown") && protocolData.otherProtocols && Array.isArray(protocolData.otherProtocols)) {
            // "otherProtocols" list usually contains: ["Aave", "Aave V3", ...]
            // We want to find a child that isn't the parent itself (avoids infinite loop)
            const parentName = protocolData.name;
            const childProtocol = protocolData.otherProtocols.find((p: string) => p !== parentName && p !== "Aave"); // "Aave" seems to be the parent name in the list too

            if (childProtocol) {
                console.log(`[DeFiLlama] Category missing for ${protocolData.name}. Trying child: ${childProtocol}`);
                const fallbackCategory = await fetchCategoryFromChild(childProtocol);
                if (fallbackCategory) {
                    category = fallbackCategory;
                }
            }
        }

        // Final fallback
        if (!category) category = "Unknown";

        // TVL is an array of historical data - get current TVL from currentChainTvls or last entry
        let currentTvl = 0;
        if (protocolData.currentChainTvls) {
            // Sum all non-borrowed, non-staking, non-pool2 TVLs
            for (const [key, value] of Object.entries(protocolData.currentChainTvls)) {
                if (!key.includes('-borrowed') && !key.includes('-staking') && !key.includes('-pool2') && key !== 'borrowed' && key !== 'staking' && key !== 'pool2') {
                    currentTvl += (value as number) || 0;
                }
            }
        } else if (Array.isArray(protocolData.tvl) && protocolData.tvl.length > 0) {
            // Fallback: get from last entry in tvl array
            const lastEntry = protocolData.tvl[protocolData.tvl.length - 1];
            currentTvl = lastEntry?.totalLiquidityUSD || 0;
        }

        return {
            name: protocolData.name || protocol,
            slug: slug,
            category: category,
            chains: protocolData.chains || [],
            tvl: currentTvl,
            tvlChange24h: protocolData.change_1d,
            fees24h: feesData?.total24h || undefined,
            fees7d: feesData?.total7d || undefined,
            fees30d: feesData?.total30d || undefined,
            revenue24h: revenueData?.total24h || undefined,
            revenue7d: revenueData?.total7d || undefined,
            volume24h: protocolData.total24h || undefined,
            description: protocolData.description,
            url: protocolData.url,
            twitter: protocolData.twitter,
            mcap: protocolData.mcap || undefined,
            symbol: protocolData.symbol || undefined
        };

    } catch (error) {
        console.error(`[DeFiLlama] Error fetching protocol stats for ${protocol}:`, error);
        return null;
    }
}

/**
 * Format protocol stats as readable text
 */
export function formatProtocolStats(stats: ProtocolStats): string {
    const lines: string[] = [];

    lines.push(`### 📊 ${stats.name}`);
    lines.push("");
    lines.push(`**Category:** ${stats.category}`);
    lines.push(`**Chains:** ${stats.chains.slice(0, 5).join(", ")}${stats.chains.length > 5 ? ` +${stats.chains.length - 5} more` : ""}`);
    lines.push("");

    lines.push("**Key Metrics:**");
    lines.push(`• TVL: $${formatNumber(stats.tvl)}`);
    if (stats.tvlChange24h !== undefined) {
        const arrow = stats.tvlChange24h >= 0 ? "📈" : "📉";
        lines.push(`• TVL Change 24h: ${arrow} ${stats.tvlChange24h.toFixed(2)}%`);
    }
    if (stats.fees24h !== undefined) {
        lines.push(`• Fees 24h: $${formatNumber(stats.fees24h)}`);
    }
    if (stats.revenue24h !== undefined) {
        lines.push(`• Revenue 24h: $${formatNumber(stats.revenue24h)}`);
    }
    if (stats.volume24h !== undefined) {
        lines.push(`• Volume 24h: $${formatNumber(stats.volume24h)}`);
    }

    if (stats.url) {
        lines.push("");
        lines.push(`🔗 [Website](${stats.url})`);
    }

    return lines.join("\n");
}

// ============================================================
// Bridge Analytics
// ============================================================

const BRIDGES_BASE_URL = "https://bridges.llama.fi";

export interface BridgeData {
    id: number | string;
    name: string;
    displayName: string;
    volume24h: number;
    volumeWeekly: number;
    volumeMonthly: number;
    tvl?: number;
    chains: string[];
    destinationChain?: string;
}

/**
 * Get bridge volume data.
 * bridges.llama.fi is paywalled — we fall back to the free DeFiLlama protocols
 * endpoint and filter for known bridge protocols.
 */
export async function getBridges(): Promise<BridgeData[] | null> {
    try {
        // Free fallback: filter DeFiLlama protocols list for bridge-type protocols
        const response = await fetch(`https://api.llama.fi/protocols`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });

        if (!response.ok) {
            throw new Error(`Protocols API error: ${response.status}`);
        }

        const data: any[] = await response.json();

        // Filter for bridge protocols by category
        const bridges = data
            .filter((p: any) => p.category === 'Bridge' || p.category === 'Cross Chain')
            .map((p: any) => ({
                id: p.id || p.slug,
                name: p.name,
                displayName: p.name,
                volume24h: p.change_1d ? Math.abs(p.tvl * (p.change_1d / 100)) : 0,
                volumeWeekly: p.change_7d ? Math.abs(p.tvl * (p.change_7d / 100)) : 0,
                volumeMonthly: p.change_1m ? Math.abs(p.tvl * (p.change_1m / 100)) : 0,
                tvl: p.tvl || 0,
                chains: p.chains || [],
                destinationChain: undefined,
            }))
            .sort((a: any, b: any) => b.tvl - a.tvl)
            .slice(0, 10);

        return bridges.length > 0 ? bridges : null;

    } catch (error) {
        console.error("[DeFiLlama] Error fetching bridges:", error);
        return null;
    }
}

/**
 * Format bridges list as readable text
 */
export function formatBridgesList(bridges: BridgeData[]): string {
    const lines: string[] = [];

    lines.push("### 🌉 Top Bridges by 24h Volume");
    lines.push("");

    for (const bridge of bridges.slice(0, 10)) {
        const chains = bridge.chains.slice(0, 2).join(", ");
        const moreChains = bridge.chains.length > 2 ? ` +${bridge.chains.length - 2}` : "";
        lines.push(`• ${bridge.displayName}: $${formatNumber(bridge.volume24h)} (weekly: $${formatNumber(bridge.volumeWeekly)}) — ${chains}${moreChains}`);
    }

    return lines.join("\n");
}

// ============================================================
// Hacks Database
// ============================================================

export interface HackData {
    name: string;
    date: number;
    amount: number;
    chain: string[];
    classification: string;
    technique: string;
    targetType: string;
    source: string;
    returnedFunds: number | null;
    bridgeHack: boolean;
}

/**
 * Get recent DeFi hacks/exploits
 */
export async function getHacks(): Promise<HackData[] | null> {
    try {
        const response = await fetch(`${DEFILLAMA_BASE_URL}/hacks`);

        if (!response.ok) {
            throw new Error(`Hacks API error: ${response.status}`);
        }

        const data = await response.json();

        return data
            .map((hack: any) => ({
                name: hack.name,
                date: hack.date * 1000, // Convert to ms
                amount: hack.amount || 0,
                chain: hack.chain || [],
                classification: hack.classification || "Unknown",
                technique: hack.technique || "Unknown",
                targetType: hack.targetType || "Unknown",
                source: hack.source || "",
                returnedFunds: hack.returnedFunds || null,
                bridgeHack: hack.bridgeHack || false
            }))
            .sort((a: HackData, b: HackData) => b.date - a.date)
            .slice(0, 15);

    } catch (error) {
        console.error("[DeFiLlama] Error fetching hacks:", error);
        return null;
    }
}

/**
 * Format hacks list as readable text
 */
export function formatHacksList(hacks: HackData[]): string {
    const lines: string[] = [];

    lines.push("### ⚠️ Recent DeFi Exploits");
    lines.push("");

    for (const hack of hacks.slice(0, 10)) {
        const date = new Date(hack.date).toLocaleDateString();
        const amount = hack.amount > 0 ? `$${formatNumber(hack.amount)}` : "N/A";
        lines.push(`• ${date} — ${hack.name}: ${amount} (${hack.classification})`);
    }

    return lines.join("\n");
}

// ============================================================
// Helper Functions
// ============================================================

function formatNumber(input: number | string | undefined | null): string {
    if (input === undefined || input === null) return "0";
    const num = typeof input === "string" ? parseFloat(input) : input;

    if (isNaN(num)) return "0";

    if (num >= 1e9) {
        return (num / 1e9).toFixed(2) + "B";
    } else if (num >= 1e6) {
        return (num / 1e6).toFixed(2) + "M";
    } else if (num >= 1e3) {
        return (num / 1e3).toFixed(2) + "K";
    }
    return num.toFixed(2);
}
