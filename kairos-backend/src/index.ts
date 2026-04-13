import "./load-env.js";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";
import { generateResponse, initGemini } from "./services/gemini.js";
import { logWebSearchConfigOnce } from "./services/search.js";
import { warmRagIndex } from "./services/rag.js";
import { ethers } from "ethers";
import { getNativeBalance } from "./services/fourmeme-balance.js";
import { getChainProvider, loadFourmemeChainConfigFromEnv } from "./services/fourmeme-chain.js";
import {
    initSupabase,
    createChatSession,
    getChatSessions,
    deleteChatSession,
    saveMessage,
    getMessages,
    clearMessages,
    rateMessage,
    getMessageRating,
    getAgentRating,
    logQueryTime,
    getAverageResponseTime,
    getTotalUsageCount,
    getAllAgentStats,
    getAgentStatsById,
    getAgentTreasuryBalance,
    getAgentTreasuryTrend,
    getPersistedLogicalIdsForAgent,
    getRecentQueries,
    ensureChatSessionById,
    updateQueryLogTxHash
} from "./services/supabase.js";

const app = express();
// Railway / reverse proxies send X-Forwarded-* — required so express-rate-limit and req.ip stay valid.
app.set("trust proxy", 1);

type LocalQueryLog = {
    id: string;
    agentId: string;
    responseTimeMs: number;
    createdAt: string;
    txHash?: string;
    /** Override the nominal USD amount shown before on-chain confirmation (e.g. 0.005 for A2A) */
    nominalUsd?: number;
    /** 'credit' (default) = received payment, 'debit' = sent A2A payment */
    direction?: 'credit' | 'debit';
};

// Nominal pricing used for UI/activity-feed display. Real settlement uses on-chain AgentRegistry priceWei.
const DEFAULT_AGENT_PRICE_BNB = Number(process.env.KAIROS_DEFAULT_AGENT_PRICE_BNB || "0.0005") || 0.0005;
const AGENT_PRICING: Record<string, number> = {
    oracle: DEFAULT_AGENT_PRICE_BNB,
    news: DEFAULT_AGENT_PRICE_BNB,
    yield: DEFAULT_AGENT_PRICE_BNB,
    tokenomics: DEFAULT_AGENT_PRICE_BNB,
    "chain-scout": DEFAULT_AGENT_PRICE_BNB, // Chain Scout
    perp: DEFAULT_AGENT_PRICE_BNB,
    protocol: DEFAULT_AGENT_PRICE_BNB,
    bridges: DEFAULT_AGENT_PRICE_BNB,
    "dex-volumes": DEFAULT_AGENT_PRICE_BNB, // DEX Volumes
    scout: DEFAULT_AGENT_PRICE_BNB, // Chat alias used by Gemini; maps to Chain Scout line item.
};

const localQueryLogs: LocalQueryLog[] = [];
const localRatings = new Map<string, boolean>(); // key: `${messageId}:${walletLower}`
// In-memory fallback stats when Supabase is unavailable.
// agentId -> { positive, total }
const localAgentRatings = new Map<string, { positive: number; total: number }>();
// Track per (messageId+wallet) agent vote so we can update counts on changes
const localRatingMeta = new Map<string, { agentId?: string; isPositive: boolean }>();
const receiptStore = new Map<string, Record<string, string>>(); // requestId -> agentId -> txHash

function toRatingKey(messageId: string, wallet: string) {
    return `${messageId}:${wallet.toLowerCase()}`;
}

function pushLocalQueryLog(entry: LocalQueryLog) {
    // Deduplicate by id — never log the same entry twice
    if (localQueryLogs.some(q => q.id === entry.id)) return;
    localQueryLogs.unshift(entry);
    // Keep memory bounded for long dev sessions.
    if (localQueryLogs.length > 2000) {
        localQueryLogs.length = 2000;
    }
}

function recordReceipt(requestId: string, agentId: string, txHash: string) {
    const existing = receiptStore.get(requestId) || {};
    existing[agentId] = txHash;
    receiptStore.set(requestId, existing);

    // Also backfill local activity rows for dashboards.
    // row.id is usually `logical_id` (e.g. `rid-credit-oracle` or `rid-a2a-out-news`), so match by prefix
    for (const row of localQueryLogs) {
        if (row.id.startsWith(requestId) && row.agentId === agentId) {
            row.txHash = txHash;
        }
    }

    // Persist backfill into Supabase so prod dashboards don't stay stuck at "no receipt logged"
    // when the treasury tx arrives after the initial insert.
    const logicalId = `${requestId}-credit-${agentId}`;
    void updateQueryLogTxHash(logicalId, txHash).catch(() => {});
}

function resolveTxHashForAgent(
    txHashes: Record<string, string | undefined>,
    agentId: string
): string | undefined {
    return txHashes[agentId];
}

type ActivityRow = {
    id: string;
    logicalId?: string;
    agentId: string;
    responseTimeMs: number;
    createdAt: string;
    txHash?: string | null;
    nominalUsd?: number;
    direction?: 'credit' | 'debit';
};

/**
 * Parse on-chain value (native BNB) for a tx hash.
 */
async function evmPaymentFromTx(txHash: string): Promise<{ code: string; amount: string } | null> {
    try {
        const cfg = loadFourmemeChainConfigFromEnv();
        const { provider } = await getChainProvider(cfg);
        const tx = await provider.getTransaction(txHash);
        if (!tx) return null;
        const value = tx.value ?? 0n;
        return { code: "BNB", amount: ethers.formatEther(value) };
    } catch {
        return null;
    }
}

// --- Configuration ---
const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// CORS — default: reflect the browser Origin (works with any Vercel/custom domain). STRICT_CORS=1 = allowlist only.
const DEFAULT_ORIGINS = ["http://localhost:5173", "http://localhost:3000", "http://localhost:8080"];
function parseAllowedOrigins(): string[] {
    const raw = process.env.ALLOWED_ORIGINS?.trim();
    if (!raw) return [...DEFAULT_ORIGINS];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
const ALLOWED_ORIGINS = parseAllowedOrigins();
const STRICT_CORS = process.env.STRICT_CORS === "1";

function isVercelPreviewOrigin(origin: string): boolean {
    try {
        const u = new URL(origin);
        return u.protocol === "https:" && /\.vercel\.app$/i.test(u.hostname);
    } catch {
        return false;
    }
}

const CORS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

if (STRICT_CORS) {
    app.use(
        cors({
            origin(origin, callback) {
                if (!origin) {
                    callback(null, true);
                    return;
                }
                if (ALLOWED_ORIGINS.includes(origin) || isVercelPreviewOrigin(origin)) {
                    callback(null, true);
                    return;
                }
                console.warn(`[CORS] Blocked origin (STRICT_CORS=1): ${origin}`);
                callback(new Error(`CORS blocked: ${origin}`));
            },
            credentials: true,
            methods: CORS_METHODS,
            maxAge: 86_400,
        })
    );
} else {
    // Reflect request Origin — avoids Railway/Vercel mismatches when ALLOWED_ORIGINS is wrong or stale.
    app.use(
        cors({
            origin: true,
            credentials: true,
            methods: CORS_METHODS,
            maxAge: 86_400,
        })
    );
}

// Rate Limiters
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500, // Increased for hackathon scaling
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    handler: (req, res) => {
        res.status(429).json({ 
            success: false, 
            error: "Too many requests, keep it cool. 🧊" 
        });
    }
});
const queryLimiter = rateLimit({ 
    windowMs: 60 * 1000, 
    max: 100, // Increased for parallel agentic calls
    handler: (req, res) => {
        res.status(429).json({ 
            success: false, 
            error: "Query rate limit exceeded. Just a moment for the AI to breathe! ⏳" 
        });
    }
});

app.use(generalLimiter);
app.use(express.json({ limit: '50mb' }));

// --- Initialization ---

logWebSearchConfigOnce();

// Initialize AI
if (GROQ_API_KEY) {
    // Backwards-compatible init function name; now initializes Groq.
    initGemini(GROQ_API_KEY);
    console.log("✅ Groq AI initialized");
    warmRagIndex();
} else {
    console.warn("⚠️  GROQ_API_KEY not set — AI queries will fail");
}

// Log Treasury Public Key for debug
const paymentsMode = String(process.env.KAIROS_PAYMENTS || "fourmeme").toLowerCase();
const isOnchainMode = !paymentsMode.startsWith("off");
if (!isOnchainMode) {
    console.warn("⚠️ KAIROS_PAYMENTS is off — on-chain receipts will be skipped.");
}
try {
    const cfg = loadFourmemeChainConfigFromEnv();
    const pk0x = cfg.treasuryPrivateKey.startsWith("0x") ? cfg.treasuryPrivateKey : `0x${cfg.treasuryPrivateKey}`;
    const treasuryAddr = new ethers.Wallet(pk0x).address;
    console.log(`🏦 Treasury Address: ${treasuryAddr}`);
} catch {
    console.warn("⚠️ FOURMEME_TREASURY_PRIVATE_KEY not configured");
}

// Initialize Database
if (initSupabase()) {
    console.log("✅ Supabase initialized");
}

// --- API Routes ---

// Health
app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        network: "fourmeme-sprint-testnet",
        chainId: 97,
        llmEnabled: !!GROQ_API_KEY,
        paymentsMode: String(process.env.KAIROS_PAYMENTS || "fourmeme"),
    });
});

async function balanceHandler(req: express.Request, res: express.Response) {
    try {
        const raw = String(req.params.address || "");
        const address = raw.trim();
        if (!ethers.isAddress(address)) return res.status(400).json({ error: "Invalid address" });
        const checksummed = ethers.getAddress(address);
        const bnb = await getNativeBalance(checksummed);
        res.json({ address: checksummed, bnb });
    } catch (e: any) {
        res.status(500).json({ error: e?.message || "Failed to fetch balance" });
    }
}

app.get("/api/fourmeme/balance/:address", balanceHandler);

async function faucetHandler(req: express.Request, res: express.Response) {
    try {
        const { address: rawAddress, amount } = req.body as { address?: string; amount?: string };
        const address = String(rawAddress || "").trim();
        if (!address || !ethers.isAddress(address)) return res.status(400).json({ success: false, error: "Valid address required" });
        const to = ethers.getAddress(address);

        const amt = amount && typeof amount === "string" ? amount : "0.01";
        const value = ethers.parseEther(amt);
        const cfg = loadFourmemeChainConfigFromEnv();
        const { provider, rpcUrl } = await getChainProvider(cfg);
        const pk = cfg.treasuryPrivateKey.startsWith("0x") ? cfg.treasuryPrivateKey : `0x${cfg.treasuryPrivateKey}`;
        const wallet = new ethers.Wallet(pk, provider);
        const treasuryAddr = await wallet.getAddress();
        if (to.toLowerCase() === treasuryAddr.toLowerCase()) {
            return res.status(400).json({
                success: false,
                error: "Faucet destination is the treasury wallet. Switch to a different wallet/account to receive testnet funds.",
            });
        }
        const tx = await wallet.sendTransaction({ to, value });
        res.json({ success: true, txHash: tx.hash, amount: amt, token: "BNB", to, rpcHost: (() => { try { return new URL(rpcUrl).hostname; } catch { return "rpc"; } })() });
    } catch (e: any) {
        res.status(500).json({ success: false, error: e?.message || "Faucet failed" });
    }
}

app.post("/api/fourmeme/faucet", faucetHandler);

async function rpcHealthHandler(req: express.Request, res: express.Response) {
    try {
        const cfg = loadFourmemeChainConfigFromEnv();
        const { provider, rpcUrl } = await getChainProvider(cfg);
        const [net, latest] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
        let rpcHost = "rpc";
        try {
            rpcHost = new URL(rpcUrl).hostname;
        } catch {
            /* ignore */
        }
        res.json({
            ok: true,
            chainId: Number(net.chainId),
            latestBlock: latest,
            rpcUrl,
            rpcHost,
        });
    } catch (e: any) {
        res.status(503).json({ ok: false, error: e?.message || "RPC unhealthy" });
    }
}

app.get("/api/fourmeme/rpc-health", rpcHealthHandler);

// Ground-truth config for UI/debugging (no secrets)
app.get("/api/config", (req, res) => {
    const chainId = Number(process.env.FOURMEME_CHAIN_ID || process.env.BSC_CHAIN_ID || "97") || 97;
    const rpc =
        (process.env.FOURMEME_RPC_URLS ||
            process.env.FOURMEME_RPC_URL ||
            process.env.BSC_RPC_URLS ||
            process.env.BSC_RPC_URL ||
            "").split(",")[0]?.trim() || "";
    res.json({
        ok: true,
        network: "bnb-testnet",
        chainId,
        rpcUrl: rpc,
        agentRegistry: (process.env.KAIROS_AGENT_REGISTRY_EVM_ADDRESS || "").trim() || null,
        spendingPolicy: (process.env.KAIROS_SPENDING_POLICY_EVM_ADDRESS || "").trim() || null,
        pricing: {
            perAgentCallBnb: (process.env.KAIROS_DEFAULT_AGENT_PRICE_BNB || "0.0005").trim(),
            a2aBnb: (process.env.KAIROS_A2A_PRICE_BNB || "0.00025").trim(),
        },
        webSearch: {
            provider: (process.env.KAIROS_WEB_SEARCH_PROVIDER || "auto").trim(),
            live: !!((process.env.TAVILY_API_KEY || "").trim() || (process.env.BRAVE_SEARCH_API_KEY || "").trim()),
        },
    });
});

// Core AI Query Endpoint
app.post("/query", queryLimiter, async (req, res) => {
    try {
        const { query, imageData, conversationHistory, requestId, tone } = req.body;
        if (!query && !imageData) return res.status(400).json({ error: "Query or image required" });

        const startTime = Date.now();
        const rid = typeof requestId === "string" && requestId.length > 0 ? requestId : crypto.randomUUID();
        const result = await generateResponse(
            query || '',
            imageData,
            conversationHistory,
            (agentId, txHash) => recordReceipt(rid, agentId, txHash),
            { tone: tone === "beginner" ? "beginner" : tone === "research" ? "research" : "trader" }
        );
        const responseTimeMs = Date.now() - startTime;

        // Log agent usage via Supabase (asynchronously, don't block response)
        try {
            const allAgentsToLog = new Set<string>(result.agentsUsed);
            // Sub-agents paid via A2A must NOT also get a treasury credit — that would double-count.
            const a2aReceivers = new Set((result.a2aPayments || []).map(p => p.to));

            const logTs = new Date().toISOString();
            for (const agentId of allAgentsToLog) {
                // Skip sub-agents here — they get credited via the A2A loop below
                if (a2aReceivers.has(agentId)) continue;
                const txHash = resolveTxHashForAgent(result.txHashes, agentId);
                const nominalUsd = AGENT_PRICING[agentId] ?? DEFAULT_AGENT_PRICE_BNB;
                const logId = `${rid}-credit-${agentId}`;
                pushLocalQueryLog({
                    id: logId,
                    agentId,
                    responseTimeMs,
                    createdAt: logTs,
                    txHash,
                    nominalUsd,
                    direction: 'credit',
                });
                logQueryTime(responseTimeMs, agentId, txHash, 'credit', nominalUsd, logId)
                    .catch(err => console.error(`[Supabase] Deferred logging failed for ${agentId}:`, err));
            }

            // Log A2A payments persistently for both sides:
            // - sub-agent credit (received BNB)
            // - primary agent debit (sent BNB)
            for (const a2a of (result.a2aPayments || [])) {
                const ts = new Date().toISOString();
                const a2aAmt = parseFloat(a2a.amount) || (Number(process.env.KAIROS_A2A_PRICE_BNB || "0.00025") || 0.00025);
                const inId  = `${rid}-a2a-in-${a2a.to}`;
                const outId = `${rid}-a2a-out-${a2a.from}`;

                pushLocalQueryLog({
                    id: inId,
                    agentId: a2a.to,
                    responseTimeMs,
                    createdAt: ts,
                    txHash: a2a.txHash,
                    nominalUsd: a2aAmt,
                    direction: 'credit',
                });
                pushLocalQueryLog({
                    id: outId,
                    agentId: a2a.from,
                    responseTimeMs,
                    createdAt: ts,
                    txHash: a2a.txHash,
                    nominalUsd: a2aAmt,
                    direction: 'debit',
                });
                // Persist both sides to Supabase so balance survives restarts
                logQueryTime(responseTimeMs, a2a.to,   a2a.txHash, 'credit', a2aAmt, inId)
                    .catch(err => console.error(`[Supabase] A2A credit log failed:`, err));
                logQueryTime(responseTimeMs, a2a.from, a2a.txHash, 'debit',  a2aAmt, outId)
                    .catch(err => console.error(`[Supabase] A2A debit log failed:`, err));
            }
        } catch (logError) {
            console.error("[Supabase] ⚠️ Telemetry logging failed (non-critical):", logError);
        }

        const agentsUsed = Array.from(result.agentsUsed);

        res.json({
            success: true,
            response: result.response,
            agentsUsed,
            txHashes: result.txHashes,
            a2aPayments: result.a2aPayments || [],
            requestId: rid,
            partial: !!result.partial,
            cost: "0.03",
            ragSources: result.ragSources,
            webSources: result.webSources,
        });
    } catch (error) {
        const msg = (error as Error)?.message || "Unknown error";
        console.error("Query error:", msg);
        // Gemini permission / project issues should not look like a generic 500 in the UI.
        const isGeminiDenied =
            msg.includes("403") &&
            (msg.toLowerCase().includes("denied access") ||
                msg.toLowerCase().includes("permission") ||
                msg.toLowerCase().includes("forbidden"));
        if (isGeminiDenied) {
            return res.status(503).json({
                success: false,
                error:
                    "AI provider is currently unavailable (permission denied). Check your `GROQ_API_KEY` / Groq project access, then retry.",
                provider: "groq",
            });
        }
        res.status(500).json({ success: false, error: msg });
    }
});

// Receipts: async tx hash fetch for fast responses
app.get("/receipts/:requestId", (req, res) => {
    const { requestId } = req.params;
    const receipts = receiptStore.get(requestId) || {};
    res.json({ requestId, receipts });
});

// Marketplace Providers
app.get("/providers", async (req, res) => {
    try {
        const perCall = (process.env.KAIROS_DEFAULT_AGENT_PRICE_BNB || "0.0005").trim();
        const providers = [
            { id: "oracle", name: "Price Oracle", category: "DeFi", description: "Real-time crypto prices via CoinGecko. Supports 200+ tokens with market cap, volume & 24h change.", price: perCall },
            { id: "news", name: "News Scout", category: "Analytics", description: "Crypto news & sentiment analysis. Breaking news, trending topics, and market-moving events.", price: perCall },
            { id: "yield", name: "Yield Optimizer", category: "DeFi", description: "Best DeFi yields across 500+ protocols. Filter by chain, APY, and TVL for optimal returns.", price: perCall },
            { id: "tokenomics", name: "Tokenomics Analyzer", category: "Analytics", description: "Token supply, distribution & unlock schedules. Inflation models and emission analysis.", price: perCall },
            { id: "chain-scout", name: "Chain Scout", category: "Infrastructure", description: "BNB testnet chain pulse (recent blocks, gas, native BNB in motion) and 0x account facts.", price: perCall },
            { id: "perp", name: "Perp Stats", category: "Trading", description: "Perpetual futures data from 7+ exchanges. Funding rates, open interest, and volume analysis.", price: perCall },
            { id: "protocol", name: "Protocol Stats", category: "DeFi", description: "TVL, fees & revenue for 100+ DeFi protocols via DeFiLlama. Cross-chain protocol comparisons.", price: perCall },
            { id: "bridges", name: "Bridge Monitor", category: "DeFi", description: "Cross-chain bridge volumes and activity. Track capital flows across chains.", price: perCall },
            { id: "dex-volumes", name: "DEX Volumes", category: "Analytics", description: "DEX volume overview (by chain / top DEXs) via DeFiLlama.", price: perCall },
        ];

        const stats = await getAllAgentStats();
        const statsMap = new Map(stats.map(s => [s.agentId, s]));

        const providersWithStats = providers.map(p => {
            const s = statsMap.get(p.id);
            const local = localAgentRatings.get(p.id);
            const localRating =
                local && local.total > 0 ? Math.round(((local.positive / local.total) * 5) * 10) / 10 : 0;
            const localTotalRatings = local?.total || 0;
            return {
                ...p,
                rating: (s?.totalRatings ? s.rating : localRating) || 0,
                totalRatings: (s?.totalRatings ? s.totalRatings : localTotalRatings) || 0,
                usageCount: s?.usageCount || 0,
                avgResponseTime: s?.avgResponseTimeMs ? (s.avgResponseTimeMs / 1000).toFixed(1) + 's' : '0s'
            };
        });

        res.json({ providers: providersWithStats });
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Dashboard Stats
app.get("/dashboard/stats", async (req, res) => {
    const rawId = req.query.agentId;
    const agentId = (Array.isArray(rawId) ? rawId[0] : rawId) as string | undefined;
    try {
        if (agentId) {
            const [stats, dbBalance, persistedLogicalIds, recentTrend] = await Promise.all([
                getAgentStatsById(agentId),
                getAgentTreasuryBalance(agentId),
                getPersistedLogicalIdsForAgent(agentId),
                getAgentTreasuryTrend(agentId)
            ]);

            const localAgentLogs = localQueryLogs.filter(q => q.agentId === agentId);
            // Rows in memory that are not yet visible in Supabase (insert lag / failed upsert / timeouts)
            const nowMs = Date.now();
            const canSafelyMergeLocal =
                // If this is empty, it might mean: Supabase is down, query failed, or migration missing.
                // In that case, merging local logs risks double-counting vs dbBalance.
                persistedLogicalIds.size > 0;

            const localDelta = canSafelyMergeLocal
                ? localAgentLogs
                      .filter((q) => q.id && !persistedLogicalIds.has(q.id))
                      // Only treat *very recent* in-memory rows as "not yet persisted"
                      .filter((q) => {
                          const ts = Date.parse(q.createdAt);
                          if (!Number.isFinite(ts)) return false;
                          return nowMs - ts < 2 * 60 * 1000; // 2 minutes
                      })
                      .reduce((sum, q) => {
                          const def =
                              q.direction === "debit"
                                  ? Number(process.env.KAIROS_A2A_PRICE_BNB || "0.00025") || 0.00025
                                  : AGENT_PRICING[agentId] ?? DEFAULT_AGENT_PRICE_BNB;
                          const amt = q.nominalUsd != null && q.nominalUsd > 0 ? q.nominalUsd : def;
                          return q.direction === "debit" ? sum - amt : sum + amt;
                      }, 0)
                : 0;

            // If Supabase is reachable, trust dbBalance; only add localDelta when we can safely dedupe.
            // If Supabase is NOT reachable (dbBalance=0) but we have in-memory logs, fall back to local-only.
            const localOnly = localAgentLogs.reduce((sum, q) => {
                const def =
                    q.direction === "debit"
                        ? Number(process.env.KAIROS_A2A_PRICE_BNB || "0.00025") || 0.00025
                        : AGENT_PRICING[agentId] ?? DEFAULT_AGENT_PRICE_BNB;
                const amt = q.nominalUsd != null && q.nominalUsd > 0 ? q.nominalUsd : def;
                return q.direction === "debit" ? sum - amt : sum + amt;
            }, 0);

            const treasury = dbBalance > 0 ? dbBalance + localDelta : localOnly;
            const usageCount = stats?.usageCount || localAgentLogs.filter(q => q.direction !== 'debit').length;
            
            // Calculate trend percentage (daily growth relative to total)
            let trendPct = 0;
            if (treasury > 0 && recentTrend > 0) {
                trendPct = (recentTrend / treasury) * 100;
            }

            res.json({
                agentId,
                tasksCompleted: usageCount,
                rating: stats?.rating || 0,
                treasury: treasury.toFixed(6),
                trend: trendPct > 0 ? trendPct.toFixed(1) : 0,
            });
        } else {
            const [usageCount, dbBalance, recentTrend] = await Promise.all([
                getTotalUsageCount(),
                getAgentTreasuryBalance("oracle"), // Total treasury fallback
                getAgentTreasuryTrend()
            ]);
            
            const fallbackUsageCount = localQueryLogs.length;
            const treasury = dbBalance || 0;
            
            let trendPct = 0;
            if (treasury > 0 && recentTrend > 0) {
                trendPct = (recentTrend / treasury) * 100;
            }
            
            res.json({ 
                usageCount: usageCount || fallbackUsageCount,
                treasury: treasury.toFixed(6),
                trend: trendPct > 0 ? trendPct.toFixed(1) : 0,
            });
        }
    } catch (error) {
        res.status(500).json({ error: (error as Error).message });
    }
});

// Dashboard Activity Feed
app.get("/dashboard/activity", async (req, res) => {
    const { agentId, limit } = req.query;
    const queryAgentId = (agentId as string) || 'oracle';
    const queryLimit = parseInt(limit as string) || 10;

    const buildActivities = async (enriched: ActivityRow[]) => {
        const rows = enriched.map((q) => ({
            id: q.id,
            type: "query" as const,
            agentId: q.agentId,
            responseTimeMs: q.responseTimeMs,
            timestamp: q.createdAt,
            txHash: q.txHash,
            nominalUsd: q.nominalUsd ?? (AGENT_PRICING[q.agentId] ?? 0.01),
            direction: q.direction ?? 'credit',
            onChain: null as { code: string; amount: string } | null,
        }));
        for (const row of rows) {
            if (row.txHash) {
                row.onChain = await evmPaymentFromTx(row.txHash);
            }
        }
        return rows;
    };

    try {
        const queries = await getRecentQueries(queryAgentId, queryLimit);
        const localRows = localQueryLogs
            .filter(q => q.agentId === queryAgentId)
            .map(q => ({
                id: q.id,
                agentId: q.agentId,
                responseTimeMs: q.responseTimeMs,
                createdAt: q.createdAt,
                txHash: q.txHash || null,
                nominalUsd: q.nominalUsd,
                direction: q.direction,
            }));

        const localById = new Map(localRows.map(q => [q.id, q]));

        // Build enriched list: start with Supabase rows (enriched with local txHash/direction),
        // then prepend any local-only rows (e.g. A2A debits) not in Supabase.
        const dbEnriched: ActivityRow[] = queries.map(q => {
            const matchKey = q.logicalId || q.id;
            const local = localById.get(matchKey);
            return {
                ...q,
                id: matchKey, // Use logical ID if available for UI consistency
                logicalId: q.logicalId,
                // Prefer local txHash if DB row doesn't have one yet
                txHash: q.txHash || local?.txHash || null,
                // direction and nominalUsd come from DB (most authoritative); fall back to local
                direction: q.direction ?? local?.direction ?? 'credit',
                nominalUsd: q.nominalUsd ?? local?.nominalUsd,
            };
        });

        // Use logicalId or fallback id to prevent duplicates
        const dbIds = new Set(queries.map(q => q.logicalId || q.id));
        const localOnly = localRows.filter(q => !dbIds.has(q.id));

        // Merge: local-only entries first (most recent), then DB entries, capped at limit
        const enriched: ActivityRow[] = [...localOnly, ...dbEnriched]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, queryLimit);

        res.json({
            success: true,
            activities: await buildActivities(enriched),
        });
    } catch (error) {
        const enriched: ActivityRow[] = localQueryLogs
            .filter(q => q.agentId === queryAgentId)
            .slice(0, queryLimit)
            .map(q => ({
                id: q.id,
                agentId: q.agentId,
                responseTimeMs: q.responseTimeMs,
                createdAt: q.createdAt,
                txHash: q.txHash || null,
            }));
        res.json({ success: true, activities: await buildActivities(enriched) });
    }
});

// Chat Sessions — fallback to in-memory when Supabase is unavailable
const inMemorySessions = new Map<string, any[]>();
const inMemoryMessages = new Map<string, any[]>();

app.get("/chat/sessions", async (req, res) => {
    const { wallet } = req.query;
    if (!wallet) return res.status(400).json({ error: "Wallet required" });
    
    const dbSessions = await getChatSessions(wallet as string);
    if (dbSessions.length > 0) {
        return res.json({ success: true, sessions: dbSessions });
    }
    // Fallback to in-memory
    const memSessions = inMemorySessions.get((wallet as string).toLowerCase()) || [];
    res.json({ success: true, sessions: memSessions });
});

app.post("/chat/sessions", async (req, res) => {
    const { walletAddress, title } = req.body;
    const session = await createChatSession(walletAddress, title);
    
    if (session) {
        return res.json({ success: true, session });
    }
    
    // Fallback: create in-memory session
    const memSession = {
        id: crypto.randomUUID(),
        wallet_address: walletAddress?.toLowerCase(),
        title: title || 'New Chat',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    const key = walletAddress?.toLowerCase();
    const existing = inMemorySessions.get(key) || [];
    existing.unshift(memSession);
    inMemorySessions.set(key, existing);
    
    res.json({ success: true, session: memSession });
});

app.get("/chat/sessions/:sessionId/messages", async (req, res) => {
    const { sessionId } = req.params;
    const dbMessages = await getMessages(sessionId);
    if (dbMessages.length > 0) {
        return res.json({ success: true, messages: dbMessages });
    }
    // Fallback
    const memMessages = inMemoryMessages.get(sessionId) || [];
    res.json({ success: true, messages: memMessages });
});

app.post("/chat/sessions/:sessionId/messages", async (req, res) => {
    const { sessionId } = req.params;
    try {
        const { id, content, is_user, escrow_id, tx_hash, tx_hashes, image_preview, walletAddress } = req.body;

        let message = await saveMessage(sessionId, {
            id,
            content,
            is_user,
            escrow_id,
            tx_hash,
            tx_hashes,
            image_preview,
        });

        // Real fix: if session doesn't exist in DB (FK violation), persist it lazily then retry once.
        if (!message && walletAddress) {
            const ok = await ensureChatSessionById(sessionId, walletAddress, 'New Chat');
            if (ok) {
                message = await saveMessage(sessionId, {
                    id,
                    content,
                    is_user,
                    escrow_id,
                    tx_hash,
                    tx_hashes,
                    image_preview,
                });
            }
        }
        
        if (message) {
            return res.json({ success: true, message });
        }
    } catch (e) {
        console.error("Failed to save message to DB, falling back to memory:", e);
    }
    
    // Fallback: store in-memory
    const memMessage = { ...req.body, timestamp: new Date().toISOString() };
    const existing = inMemoryMessages.get(sessionId) || [];
    existing.push(memMessage);
    inMemoryMessages.set(sessionId, existing);
    
    // Update session title from first user message
    if (req.body.is_user && req.body.content) {
        for (const [, sessions] of inMemorySessions) {
            const session = sessions.find((s: any) => s.id === sessionId);
            if (session && session.title === 'New Chat') {
                session.title = req.body.content.slice(0, 50) + (req.body.content.length > 50 ? '...' : '');
            }
        }
    }
    
    res.json({ success: true, message: memMessage });
});

// Delete chat session
app.delete("/chat/sessions/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    const wallet = req.query.wallet as string;
    
    if (!wallet) return res.status(400).json({ success: false, error: "Wallet required" });
    
    // Try Supabase first
    const deleted = await deleteChatSession(sessionId, wallet);
    
    // Also clean in-memory
    const key = wallet.toLowerCase();
    const memSessions = inMemorySessions.get(key);
    if (memSessions) {
        const filtered = memSessions.filter((s: any) => s.id !== sessionId);
        inMemorySessions.set(key, filtered);
    }
    inMemoryMessages.delete(sessionId);
    
    res.json({ success: true, deleted: deleted || true });
});

// Rename chat session
app.patch("/chat/sessions/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    const { title } = req.body;
    
    if (!title) return res.status(400).json({ success: false, error: "Title required" });
    
    // Try Supabase
    const sb = (await import("./services/supabase.js")).getSupabase();
    if (sb) {
        await sb.from('chat_sessions').update({ title }).eq('id', sessionId);
    }
    
    // Also update in-memory
    for (const [, sessions] of inMemorySessions) {
        const session = sessions.find((s: any) => s.id === sessionId);
        if (session) session.title = title;
    }
    
    res.json({ success: true });
});

// Message Ratings
app.get("/ratings/:messageId", async (req, res) => {
    const { messageId } = req.params;
    const wallet = req.query.wallet as string;
    
    if (!wallet) return res.json({ rating: null });
    
    const rating = await getMessageRating(messageId, wallet);
    const fallback = localRatings.get(toRatingKey(messageId, wallet));
    res.json({ rating: rating ?? fallback ?? null });
});

app.post("/ratings", async (req, res) => {
    const { messageId, wallet, isPositive, agentId } = req.body;
    
    if (!messageId || !wallet) {
        return res.status(400).json({ success: false, error: "messageId and wallet required" });
    }
    
    const success = await rateMessage(messageId, wallet, isPositive, agentId);
    if (!success) {
        // Keep UX functional when Supabase is transiently unavailable.
        localRatings.set(toRatingKey(messageId, wallet), !!isPositive);
        // Update in-memory aggregate stats so /providers reflects the rating.
        const key = toRatingKey(messageId, wallet);
        const prev = localRatingMeta.get(key);
        // If the same user updates their vote, undo previous count first
        if (prev?.agentId) {
            const aggPrev = localAgentRatings.get(prev.agentId) || { positive: 0, total: 0 };
            if (prev.isPositive) aggPrev.positive = Math.max(0, aggPrev.positive - 1);
            aggPrev.total = Math.max(0, aggPrev.total - 1);
            localAgentRatings.set(prev.agentId, aggPrev);
        }
        if (agentId) {
            const agg = localAgentRatings.get(agentId) || { positive: 0, total: 0 };
            agg.total += 1;
            if (isPositive) agg.positive += 1;
            localAgentRatings.set(agentId, agg);
        }
        localRatingMeta.set(key, { agentId, isPositive: !!isPositive });
        return res.json({ success: true, persisted: "memory" });
    }
    res.json({ success: true, persisted: "supabase" });
});

// All payment routes run via the Sprint testnet EVM.

// Start Server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║          KAIROS: FOUR.MEME SPRINT BUILD                  ║
╠═══════════════════════════════════════════════════════════╣
║  URL:       http://localhost:${PORT}                         ║
║  Network:   BNB Testnet (chainId 97)                      ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
