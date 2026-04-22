/**
 * Gemini Service — Four.meme AI Sprint Orchestrator
 */

import type { GroqChatMessage, GroqTool } from "./groq-client.js";
import { groqChatComplete } from "./groq-client.js";
import { fetchPrice, PriceData } from "./price-oracle.js";
import { perpStatsService } from "./perp-stats/PerpStatsService.js";
import { searchWeb as runWebResearch } from "./search.js";
import * as defillama from "./defillama.js";
import * as newsScout from "./news-scout.js";
import * as yieldOptimizer from "./yield-optimizer.js";
import * as tokenomicsService from "./tokenomics-service.js";
import * as defillamaDex from "./defillama.js";
import { retrieveRagAugmentation, type RagSource } from "./rag.js";
import { ethers } from "ethers";
import {
    loadFourmemeChainConfigFromEnv,
    sendTreasuryPayment as sendTreasuryPaymentEvm,
    sendAgentToAgentPayment as sendA2A,
} from "./fourmeme-chain.js";
import { resolveAgentEvm } from "./agent-registry-evm.js";
import { fetchChainPulse } from "./fourmeme-chain-pulse.js";

const KAIROS_PAYMENTS = (process.env.KAIROS_PAYMENTS || "fourmeme").trim().toLowerCase(); // "fourmeme" | "off"
const USE_HASHKEY = !KAIROS_PAYMENTS.startsWith("off");
const PAYMENTS_OFF = KAIROS_PAYMENTS.startsWith("off");

/**
 * Treasury must submit txs **one at a time**. Parallel tool calls used to race:
 * each tx reused the same nonce, causing reverts; parallel RPC submits also time out.
 */
let treasuryPaymentQueue: Promise<unknown> = Promise.resolve();

/** Retry a flaky async call up to `attempts` times with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, baseDelayMs = 2000): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            lastErr = err;
            const isFetchError = err?.message?.includes('fetch failed') || err?.message?.includes('ECONNRESET') || err?.message?.includes('timeout') || err?.message?.includes('ETIMEDOUT');
            if (!isFetchError || i === attempts - 1) throw err;
            const delay = baseDelayMs * 2 ** i;
            console.warn(`[Orchestrator] Attempt ${i + 1}/${attempts} failed (${err.message}). Retrying in ${delay}ms…`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

function runTreasurySerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = treasuryPaymentQueue.then(() => fn());
    treasuryPaymentQueue = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}


/**
 * 🤝 Agent-to-Agent Payment (A2A)
 * When a specialist agent delegates to another sub-agent, it pays from its own wallet.
 * This demonstrates true autonomous agent commerce — agents earning and spending on-chain.
 *
 * Agent secret keys are loaded from environment variables (set by generate-agent-wallets script).
 * Amount: 0.005 USDC per sub-delegation (half of the base rate, split economy).
 */
const AGENT_SECRETS: Record<string, string | undefined> = {
    oracle:        process.env.ORACLE_AGENT_SECRET,
    news:          process.env.NEWS_AGENT_SECRET,
    yield:         process.env.YIELD_AGENT_SECRET,
    tokenomics:    process.env.TOKENOMICS_AGENT_SECRET,
    perp:          process.env.PERP_AGENT_SECRET,
    "chain-scout": process.env.CHAIN_SCOUT_AGENT_SECRET,
    protocol:      process.env.PROTOCOL_AGENT_SECRET,
    bridges:       process.env.BRIDGES_AGENT_SECRET,
    "dex-volumes": process.env.DEX_VOLUMES_AGENT_SECRET,
};

// Optional EVM agent wallets (true A2A on-chain).
// If a key is missing, A2A payment is skipped (demo still works with treasury->agent receipts).
const AGENT_EVM_SECRETS: Record<string, string | undefined> = {
    oracle: process.env.ORACLE_EVM_PRIVATE_KEY,
    news: process.env.NEWS_EVM_PRIVATE_KEY,
    yield: process.env.YIELD_EVM_PRIVATE_KEY,
    tokenomics: process.env.TOKENOMICS_EVM_PRIVATE_KEY,
    perp: process.env.PERP_EVM_PRIVATE_KEY,
    "chain-scout": process.env.CHAIN_SCOUT_EVM_PRIVATE_KEY,
    protocol: process.env.PROTOCOL_EVM_PRIVATE_KEY,
    bridges: process.env.BRIDGES_EVM_PRIVATE_KEY,
    "dex-volumes": process.env.DEX_VOLUMES_EVM_PRIVATE_KEY,
};

export interface A2APayment {
    from: string;
    to: string;
    amount: string;
    txHash: string;
    label: string;
}

// Track a2a payments for the current request
let currentA2APayments: A2APayment[] = [];

// Per-agent serial queue to avoid tx_bad_seq when an agent sends multiple payments quickly
const agentPaymentQueues = new Map<string, Promise<any>>();

function runAgentSerialized<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prev = agentPaymentQueues.get(agentId) || Promise.resolve();
    const next = prev.then(() => fn());
    agentPaymentQueues.set(agentId, next.then(() => undefined, () => undefined));
    return next;
}

// Deterministic orchestrator priority — highest rank = always the primary payer.
// Prevents race conditions from Set insertion order deciding who pays whom.
const AGENT_ORCHESTRATOR_PRIORITY: Record<string, number> = {
    oracle:         10, // Price Oracle: highest — data backbone
    protocol:        9,
    bridges:         8,
    "dex-volumes":   7,
    "chain-scout":   6,
    perp:            5,
    tokenomics:      4,
    yield:           3,
    news:            2, // News Scout: always a sub-agent, never the payer
};

function pickPrimaryAgent(agents: string[]): string {
    return agents.reduce((best, a) =>
        (AGENT_ORCHESTRATOR_PRIORITY[a] ?? 0) > (AGENT_ORCHESTRATOR_PRIORITY[best] ?? 0) ? a : best
    );
}

async function sendAgentToAgentPayment(
    fromAgentId: string,
    toAgentId: string,
    label: string
): Promise<A2APayment | undefined> {
    if (PAYMENTS_OFF) return undefined;
    if (USE_HASHKEY) {
        const rpcUrl = (process.env.FOURMEME_RPC_URL || process.env.FOURMEME_RPC_URLS || process.env.BSC_RPC_URL || process.env.BSC_RPC_URLS || "").trim();
        if (!rpcUrl) return undefined;
        const chainId = process.env.FOURMEME_CHAIN_ID
            ? Number(process.env.FOURMEME_CHAIN_ID)
            : process.env.BSC_CHAIN_ID
              ? Number(process.env.BSC_CHAIN_ID)
              : undefined;

        const toMeta = await resolveAgentEvm({
            rpcUrl,
            chainId,
            registryAddress: (process.env.KAIROS_AGENT_REGISTRY_EVM_ADDRESS || "").trim() || undefined,
            agentKey: toAgentId,
        });
        if (!toMeta?.owner) return undefined;

        const fromPk = (AGENT_EVM_SECRETS[fromAgentId] || "").trim();
        if (!fromPk || !fromPk.startsWith("0x")) {
            console.warn(`[A2A] ⚠️ No EVM private key for ${fromAgentId}, skipping A2A.`);
            return undefined;
        }

        const amountWei = ethers.parseEther(process.env.KAIROS_A2A_PRICE_BNB || "0.00025");
        return runAgentSerialized(fromAgentId, async () => {
            try {
                const txHash = await sendA2A({
                    rpcUrl,
                    chainId,
                    fromPrivateKey: fromPk,
                    to: toMeta.owner,
                    amountWei,
                });
                const payment: A2APayment = {
                    from: fromAgentId,
                    to: toAgentId,
                    amount: ethers.formatEther(amountWei),
                    txHash,
                    label,
                };
                currentA2APayments.push(payment);
                return payment;
            } catch (e: any) {
                console.error(`[A2A] ❌ EVM A2A ${fromAgentId} → ${toAgentId} failed:`, e?.message || e);
                return undefined;
            }
        });
    }

    return undefined;
}

/**
 * 🚀 Real On-Chain Settlement (Sprint)
 * Sends native BNB from the Treasury to the Agent on BNB Chain testnet (chainId 97).
 */
async function sendAgentPayment(agentId: string, label: string): Promise<string | undefined> {
    if (PAYMENTS_OFF) return undefined;
    if (USE_HASHKEY) {
        try {
            const cfg = loadFourmemeChainConfigFromEnv();
            const rpcUrl = cfg.rpcUrl;
            const chainId = cfg.chainId;
            const registryAddress = (process.env.KAIROS_AGENT_REGISTRY_EVM_ADDRESS || "").trim() || undefined;
            const spendingPolicyAddress = (process.env.KAIROS_SPENDING_POLICY_EVM_ADDRESS || "").trim() || undefined;

            const agent = await resolveAgentEvm({ rpcUrl, chainId, registryAddress, agentKey: agentId });
            if (!agent?.owner) return undefined;
            const amountWei = agent.priceWei || ethers.parseEther(process.env.KAIROS_DEFAULT_AGENT_PRICE_BNB || "0.001");

            // Serialize treasury txs to avoid nonce races
            return await runTreasurySerialized(async () => {
                const txHash = await sendTreasuryPaymentEvm({
                    cfg,
                    to: agent.owner,
                    amountWei,
                    agentKey: agentId,
                    label,
                    spendingPolicy: { spendingPolicyAddress },
                });
                console.log(`[Four.meme Sprint] ✅ Paid Agent ${agentId} (${ethers.formatEther(amountWei)} BNB): ${txHash}`);
                return txHash;
            });
        } catch (e: any) {
            console.error(`[Four.meme Sprint] ❌ Payment failed for ${agentId}:`, e?.message || e);
            return undefined;
        }
    }
    return undefined;
}

// Payment wrappers — one per agent, each with its own wallet
const createOraclePayment       = (label: string) => sendAgentPayment('oracle', label);
const createNewsScoutPayment    = (label: string) => sendAgentPayment('news', label);
const createYieldOptimizerPayment = (label: string) => sendAgentPayment('yield', label);
const createTokenomicsPayment   = (label: string) => sendAgentPayment('tokenomics', label);
const createPerpStatsPayment    = (label: string) => sendAgentPayment('perp', label);
const createChainScoutPayment   = (label: string) => sendAgentPayment('chain-scout', label);
const createProtocolPayment     = (label: string) => sendAgentPayment('protocol', label);
const createBridgesPayment      = (label: string) => sendAgentPayment('bridges', label);
const createDexVolumesPayment   = (label: string) => sendAgentPayment('dex-volumes', label);

async function withTimeoutOptional<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    try {
        return await Promise.race([
            p,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
        ]);
    } catch {
        return undefined;
    }
}

// Keep responses fast: do not block on payment confirmation.
// We still use this value when callers *optionally* await a hash.
const PAYMENT_CAPTURE_TIMEOUT_MS = Number(process.env.KAIROS_PAYMENT_CAPTURE_TIMEOUT_MS || 2500);

let groqReady = false;

const SchemaType = {
    OBJECT: "object",
    STRING: "string",
    NUMBER: "number",
    BOOLEAN: "boolean",
    ARRAY: "array",
} as const;

// Track oracle usage for this session
let oracleQueryCount = 0;
// Track chain scout usage for this session
let scoutQueryCount = 0;
// Track news scout usage for this session
let newsScoutQueryCount = 0;
// Track yield optimizer usage for this session
let yieldOptimizerQueryCount = 0;

export function initGemini(apiKey: string) {
    // Backwards-compatible entrypoint: we no longer initialize Gemini.
    // Groq is configured via env vars: GROQ_API_KEY / GROQ_MODEL.
    // If caller passes a key, ignore it (do not log secrets).
    groqReady = true;
    console.log(`[Provider] Groq initialized with model: ${process.env.GROQ_MODEL || "llama-3.3-70b-versatile"}`);
}

// Timeout for Groq API calls
const GROQ_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 60000);
const FAST_MODE = (process.env.KAIROS_FAST_MODE || "1").trim() !== "0";
// Groq tool-calling has proven unreliable (sometimes emits <function=...> tags → HTTP 400 tool_use_failed).
// Default: OFF. We do deterministic tool routing instead.
const GROQ_TOOL_CALLING = (process.env.KAIROS_GROQ_TOOL_CALLING || "0").trim() === "1";
/** When enabled, run one extra Groq pass that must stay grounded in tool JSON (prices/headlines/snippets). */
const GROUNDED_SYNTHESIS = (process.env.KAIROS_GROUNDED_SYNTHESIS || "1").trim() !== "0";

function bundleToolJsonForSynthesis(toolJson: Record<string, any>): string {
    try {
        const raw = JSON.stringify(toolJson ?? {});
        const max = Math.max(4000, Number(process.env.KAIROS_SYNTHESIS_MAX_JSON || 32000) || 32000);
        return raw.length > max ? `${raw.slice(0, max)}\n...(truncated)` : raw;
    } catch {
        return "{}";
    }
}

async function synthesizeGroundedAnswer(userPrompt: string, toolJson: Record<string, any>): Promise<string | null> {
    if (!GROUNDED_SYNTHESIS) return null;
    if (!Object.keys(toolJson || {}).length) return null;
    try {
        const completion = await groqChatComplete({
            messages: [
                {
                    role: "system",
                    content:
                        "You are Kairos (Four.meme AI Sprint build). Write the final user-facing answer.\n\n" +
                        "HARD RULES:\n" +
                        "- Use ONLY facts supported by TOOL_JSON. If TOOL_JSON does not contain a fact, do not assert it.\n" +
                        "- For ANY numeric token price, market cap, TVL, volume, or percentage: quote ONLY from tool outputs that contain that number (usually getPriceData:*). Never guess prices.\n" +
                        "- When getPriceData includes lastUpdated, end the market section with one line: **Last updated:** <that timestamp> (human-readable).\n" +
                        "- If the user asks for **chain pulse / blocks / gas / tx counts** for BNB testnet (chainId 97), prioritize **getChainPulse** JSON for block numbers and fees; do not substitute web snippets for that on-chain data.\n" +
                        "- If a searchWeb entry has liveWeb:false, label that section clearly as an offline model summary (not verified against a live web index).\n" +
                        "- If a searchWeb entry has liveWeb:true, summarize using the provided titles/URLs/snippets; do not invent new URLs.\n" +
                        "- If tools conflict, say what differs and what you would verify next (one sentence).\n" +
                        "- Do not mention payments, agents, internal routing, 'tools', or 'JSON'.\n" +
                        "- Length: ~10–22 short lines unless the user asks for extreme detail.",
                },
                {
                    role: "user",
                    content: `USER_QUESTION:\n${(userPrompt || "").trim()}\n\nTOOL_JSON:\n${bundleToolJsonForSynthesis(toolJson)}`,
                },
            ],
            tools: undefined,
            toolChoice: "none",
            temperature: 0.15,
            maxTokens: 950,
            timeoutMs: Math.min(24000, Math.max(8000, Number(process.env.KAIROS_SYNTHESIS_TIMEOUT_MS || 18000) || 18000)),
        });
        const text = (completion.content || "").trim();
        return text.length >= 60 ? text : null;
    } catch (e: any) {
        console.warn("[Kairos] Grounded synthesis skipped:", e?.message || e);
        return null;
    }
}

/** Turn raw ISO timestamps in user-facing lines into locale date/time (synthesis often echoes JSON). */
function polishMarketTimestamps(text: string): string {
    if (!text) return text;
    const isoChunk = String.raw`[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z?`;
    const fmt = (raw: string) => {
        const d = new Date(raw.trim());
        if (Number.isNaN(d.getTime())) return raw;
        return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    };
    return text.replace(
        new RegExp(`(\\*\\*Last updated:\\*\\*\\s*|Last updated:\\s*)(${isoChunk})`, "gi"),
        (_m, pre: string, iso: string) => pre + fmt(iso)
    ).replace(
        new RegExp(`(\\*\\*Last indexed:\\*\\*\\s*|Last indexed:\\s*)(${isoChunk})`, "gi"),
        (_m, pre: string, iso: string) => pre + fmt(iso)
    );
}

function stripInlineRagCitations(text: string): string {
    if (!text) return text;
    // Remove inline citations like [Source 1], [source1], [SOURCE 12]
    const cleaned = text
        .replace(/\s*\[\s*source\s*\d+\s*\]/gi, "")
        .replace(/\s*\[\s*source\d+\s*\]/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return polishMarketTimestamps(cleaned);
}

type RoutedToolCall = { key: string; name: string; args: any };

function toolResultKeys(last: Record<string, any>, toolName: string): string[] {
    return Object.keys(last)
        .filter((k) => k === toolName || k.startsWith(`${toolName}:`))
        .sort();
}

function firstMatchingToolNode(last: Record<string, any>, toolName: string): any | undefined {
    const keys = toolResultKeys(last, toolName);
    for (const k of keys) {
        const node = last[k];
        if (node && !node.error) return node;
    }
    for (const k of keys) {
        const node = last[k];
        if (node) return node;
    }
    return undefined;
}

function formatMarketLastUpdated(iso?: string | null): string {
    if (!iso || typeof iso !== "string") return new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatSearchFetchedAt(iso?: string | null): string {
    return formatMarketLastUpdated(iso);
}

/** “Explain my wallet” and bare 0x paste → Chain Scout narrative (risks + next actions). */
function wantsWalletExplain(userPrompt: string): boolean {
    const q = (userPrompt || "").trim();
    if (!/\b0x[a-f0-9]{40}\b/i.test(q)) return false;
    if (/^\s*0x[a-f0-9]{40}\s*$/i.test(q)) return true;
    const s = q.toLowerCase();
    return (
        /\bexplain\b|\banalyze\b|\brisks?\b|\bwhat\s+should\b|\breview\b|\bwhat\s+is\s+this\b|\btell\s+me\s+about\b|\bshould\s+i\s+trust\b|\bdecode\b|\binterpret\b/.test(
            s
        ) ||
        /\b(my|this)\s+wallet\b/.test(s) ||
        /\bwallet\s+(address|addr)\b/.test(s)
    );
}

async function synthesizeWalletExplainer(userPrompt: string, toolJson: Record<string, any>): Promise<string | null> {
    const subset: Record<string, any> = {};
    for (const k of Object.keys(toolJson || {})) {
        if (k === "getChainAccount" || k.startsWith("getChainAccount:")) subset[k] = toolJson[k];
    }
    if (!Object.keys(subset).length) return null;
    try {
        const completion = await groqChatComplete({
            messages: [
                {
                    role: "system",
                    content:
                        "You are Kairos **Chain Scout**, an EVM infrastructure specialist for the Four.meme Sprint demo (BNB testnet **chainId 97**). The user asked about a wallet address.\n" +
                        "You MUST ground every factual claim in WALLET_JSON only. Never invent balances, labels, or chain IDs.\n\n" +
                        "Output exactly two sections with these headings:\n" +
                        "### Risks (3–6 short bullets)\n" +
                        "### Next actions (3–5 short bullets)\n\n" +
                        "Cover where relevant: EOA vs contract, empty/low balance and dusting, nonce / unused address, interacting with unknown contracts, phishing patterns, verifying counterparties off-chain, testnet vs mainnet (this RPC may be testnet).\n\n" +
                        "Do not repeat the raw JSON. Do not mention payments, tools, or \"JSON\".",
                },
                {
                    role: "user",
                    content: `USER_QUESTION:\n${(userPrompt || "").trim()}\n\nWALLET_JSON:\n${bundleToolJsonForSynthesis(subset)}`,
                },
            ],
            tools: undefined,
            toolChoice: "none",
            temperature: 0.15,
            maxTokens: 550,
            timeoutMs: Math.min(22000, Math.max(8000, Number(process.env.KAIROS_WALLET_EXPLAIN_TIMEOUT_MS || 16000) || 16000)),
        });
        const text = (completion.content || "").trim();
        return text.length >= 80 ? text : null;
    } catch (e: any) {
        console.warn("[Kairos] Wallet explainer skipped:", e?.message || e);
        return null;
    }
}

async function composeFastToolAnswer(
    userPrompt: string,
    routed: RoutedToolCall[],
    lastToolResultsByName: Record<string, any>
): Promise<string> {
    const rendered = renderFastFromTools(lastToolResultsByName);
    if (!rendered) return "";

    const routedNames = new Set(routed.map((r) => r.name));
    const explain = wantsWalletExplain(userPrompt);
    const explainOnly = explain && routedNames.size === 1 && routedNames.has("getChainAccount");

    let body: string;
    if (explainOnly) {
        body = rendered.trim();
    } else {
        const syn = await synthesizeGroundedAnswer(userPrompt, lastToolResultsByName);
        body = (syn || rendered).trim();
    }

    const acct = firstMatchingToolNode(lastToolResultsByName, "getChainAccount");
    if (explain && acct && !acct.error) {
        const extra = await synthesizeWalletExplainer(userPrompt, lastToolResultsByName);
        if (extra) body = `${body}\n\n${extra.trim()}`;
    }
    return body;
}

function renderFastFromTools(last: Record<string, any>): string | null {
    const sections: string[] = [];

    const hasKey = (k: string) => last[k] && !last[k].error;

    const priceKeys = toolResultKeys(last, "getPriceData");
    if (priceKeys.length) {
        const blocks = priceKeys.map((k) => {
            const d = last[k] as any;
            const sym = (d.symbol || "").toUpperCase();
            const name = d.name || sym || "Token";
            const price = d.price != null ? `$${Number(d.price).toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "N/A";
            const change = d.change24h != null ? `${Number(d.change24h).toFixed(2)}%` : "N/A";
            const athNum = d.ath != null ? Number(d.ath) : NaN;
            const ath = Number.isFinite(athNum) ? `$${athNum.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "N/A";
            const athDate = d.athDate ? new Date(d.athDate).toLocaleDateString() : "N/A";
            const drawdown =
                Number.isFinite(athNum) && Number.isFinite(Number(d.price)) && athNum > 0
                    ? `${(((Number(d.price) - athNum) / athNum) * 100).toFixed(1)}%`
                    : null;
            return (
                `The current price of **${name} (${sym})** is **${price}**.\n\n` +
                `- 24h change: ${change}\n` +
                `- Market cap: ${d.marketCap != null ? `$${Number(d.marketCap).toLocaleString()}` : "N/A"}\n` +
                `- Volume (24h): ${d.volume24h != null ? `$${Number(d.volume24h).toLocaleString()}` : "N/A"}\n` +
                `- ATH: ${ath} (reached ${athDate})` +
                (drawdown ? `\n- vs ATH: ${drawdown}` : "") +
                `\n\n**Last updated:** ${formatMarketLastUpdated(d.lastUpdated)}`
            );
        });
        sections.push(blocks.join("\n\n"));
    }

    const newsKeys = toolResultKeys(last, "getNews");
    for (const nk of newsKeys) {
        if (!hasKey(nk)) continue;
        const node = last[nk] as any;
        const articles = (node.articles || node.result?.articles || []).slice(0, 8);
        if (!articles.length) continue;
        const lines = articles.map((a: any, i: number) => `${i + 1}. ${a.title}${a.source ? ` — ${a.source}` : ""}`);
        sections.push(`**Latest headlines**\n${lines.join("\n")}`);
    }

    const searchKeys = toolResultKeys(last, "searchWeb");
    for (const sk of searchKeys) {
        if (!hasKey(sk)) continue;
        const d = last[sk] as any;
        const q = d.query ? String(d.query) : "";
        const answer = d.answer != null ? String(d.answer) : "";
        const sources = Array.isArray(d.sources) ? d.sources : [];
        const srcLines = sources
            .slice(0, 5)
            .map((s: any, i: number) => `${i + 1}. ${s.title || "Source"}${s.url ? ` — ${s.url}` : ""}`)
            .filter(Boolean);

        if (answer) {
            const mode =
                d.liveWeb === true
                    ? "Live web index"
                    : d.liveWeb === false
                      ? "Offline summary (set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for live web index)"
                      : "Research";
            const prov = d.provider ? ` · ${String(d.provider)}` : "";
            const fetched = d.fetchedAt ? formatSearchFetchedAt(d.fetchedAt) : formatSearchFetchedAt(null);
            sections.push(
                `**${mode}${prov}${q ? ` — “${q}”` : ""}**\n\n${answer}` +
                    (srcLines.length ? `\n\n**Sources**\n${srcLines.join("\n")}` : "") +
                    `\n\n**Last indexed:** ${fetched}`
            );
        }
    }

    const acctKeys = toolResultKeys(last, "getChainAccount");
    for (const ak of acctKeys) {
        if (!hasKey(ak)) continue;
        const d = last[ak] as any;
        const addr = d.address ? String(d.address) : "—";
        const bal = d.balanceBnb != null ? String(d.balanceBnb) : "?";
        const nonce = d.nonce != null ? String(d.nonce) : "?";
        const kind = d.isContract ? "Contract (bytecode at this address)" : "EOA (externally owned account)";
        sections.push(
            `**Wallet snapshot (Chain Scout · configured RPC)**\n` +
                `- **Address:** \`${addr}\`\n` +
                `- **Native balance:** ${bal} BNB\n` +
                `- **Nonce:** ${nonce}\n` +
                `- **Account type:** ${kind}`
        );
    }

    if (hasKey("getBridges")) {
        const d = last.getBridges as any;
        const bridges =
            Array.isArray(d?.topBridges) ? d.topBridges :
            Array.isArray(d?.bridges) ? d.bridges :
            Array.isArray(d?.result?.topBridges) ? d.result.topBridges :
            Array.isArray(d?.result?.bridges) ? d.result.bridges :
            [];
        if (bridges.length) {
            const lines = bridges.slice(0, 8).map((b: any, i: number) => {
                const name = b.name || b.displayName || b.bridge || b.protocol || "Bridge";
                const tvl = b.tvl != null ? `$${Number(b.tvl).toLocaleString()}` : undefined;
                return `${i + 1}. ${name}${tvl ? ` (TVL ${tvl})` : ""}`;
            });
            sections.push(`**Top bridges**\n${lines.join("\n")}`);
            sections.push(
                `\n**How to use this**\n- Use testnet funds for the demo, and always verify chainId before sending.\n- Always verify fees + supported assets on the bridge UI before sending large amounts.`
            );
        }
    }

    const pulseKeys = toolResultKeys(last, "getChainPulse");
    for (const pk of pulseKeys) {
        if (!hasKey(pk)) continue;
        const d = last[pk] as any;
        const rows = Array.isArray(d.blocks) ? d.blocks : [];
        const lines = rows.map((b: any, i: number) => {
            const num = b.number != null ? `#${b.number}` : `#?`;
            const txs = b.txCount != null ? `${b.txCount} txs` : "txs n/a";
            const vol = b.nativeMoved != null ? `${b.nativeMoved} BNB (tx.value sum)` : "";
            const gas = b.gasUsedRatio ? ` · block gas ${b.gasUsedRatio}` : "";
            return `${i + 1}. Block ${num} — ${txs}${vol ? ` · ${vol}` : ""}${gas}`;
        });
        const baseFee =
            d.latestBaseFeeGwei != null
                ? `\n- Latest base fee (EIP-1559): **${Number(d.latestBaseFeeGwei).toLocaleString(undefined, { maximumFractionDigits: 4 })} gwei**`
                : "";
        const host = d.rpcHost ? ` · RPC **${d.rpcHost}**` : "";
        sections.push(
            `**BNB testnet chain pulse** (live JSON-RPC${host})\n` +
                `- **chainId ${d.chainId ?? "?"}** · head **#${d.latestBlock}** · sampled **${d.windowBlocks ?? rows.length}** blocks · **${d.totalTxs ?? "?"}** txs in window · **${d.windowNativeMoved ?? "?"}** native BNB in \`tx.value\`${baseFee}\n` +
                (lines.length ? `\n**Blocks**\n${lines.join("\n")}` : "") +
                (d.note ? `\n\n_${String(d.note)}_` : "")
        );
    }

    if (hasKey("getYields")) {
        const d = last.getYields as any;
        const rows =
            (d?.opportunities ||
                d?.result?.opportunities ||
                d?.yields ||
                d?.result?.yields ||
                []).slice(0, 8);
        if (rows.length) {
            const lines = rows.map((y: any, i: number) =>
                `${i + 1}. ${y.protocol || "Protocol"}${y.name ? ` (${y.name})` : ""} — ${y.apy != null ? `${Number(y.apy).toFixed(2)}% APY` : "APY N/A"}${y.chain ? ` · ${y.chain}` : ""}${y.asset ? ` · ${y.asset}` : ""}`
            );
            sections.push(`**Top yields**\n${lines.join("\n")}`);
            sections.push(
                `\nIf you want, tell me your constraints (chain, minimum TVL, risk level), and I’ll narrow this to a safe shortlist.`
            );
        }
    }

    if (hasKey("getProtocolStats")) {
        const d = last.getProtocolStats as any;
        const name = d?.name || d?.result?.name || "Protocol";
        const tvl = d?.tvl ?? d?.result?.tvl;
        const fees24h = d?.fees24h ?? d?.result?.fees24h;
        const rev24h = d?.revenue24h ?? d?.result?.revenue24h;
        sections.push(
            `**Protocol stats — ${name}**\n- TVL: ${tvl != null ? `$${Number(tvl).toLocaleString()}` : "N/A"}\n- Fees (24h): ${fees24h != null ? `$${Number(fees24h).toLocaleString()}` : "N/A"}\n- Revenue (24h): ${rev24h != null ? `$${Number(rev24h).toLocaleString()}` : "N/A"}`
        );
    }

    if (hasKey("getTokenomics")) {
        const d = last.getTokenomics as any;
        const sym = (d?.symbol || d?.result?.symbol || "").toUpperCase();
        const supply = d?.circulatingSupply ?? d?.result?.circulatingSupply;
        const fdv = d?.fdv ?? d?.result?.fdv;
        sections.push(
            `**Tokenomics ${sym || ""}**\n- Circulating supply: ${supply != null ? Number(supply).toLocaleString() : "N/A"}\n- FDV: ${fdv != null ? `$${Number(fdv).toLocaleString()}` : "N/A"}`
        );
    }

    if (hasKey("getGlobalPerpStats")) {
        const d = last.getGlobalPerpStats as any;
        const oi = d?.totalOpenInterest ?? d?.result?.totalOpenInterest;
        const vol = d?.totalVolume24h ?? d?.result?.totalVolume24h;
        sections.push(
            `**Perps (global)**\n- Open interest: ${oi != null ? `$${Number(oi).toLocaleString()}` : "N/A"}\n- Volume (24h): ${vol != null ? `$${Number(vol).toLocaleString()}` : "N/A"}`
        );
    }

    if (hasKey("getPerpMarkets")) {
        const d = last.getPerpMarkets as any;
        const markets = (d?.markets || d?.result?.markets || []).slice(0, 6);
        if (markets.length) {
            const lines = markets.map((m: any, i: number) => `${i + 1}. ${m.symbol || m.market || "MARKET"} — funding ${m.fundingRate ?? "N/A"} · OI ${m.openInterest ?? "N/A"}`);
            sections.push(`**Perp markets**\n${lines.join("\n")}`);
        }
    }

    if (hasKey("getHacks")) {
        const d = last.getHacks as any;
        const hacks = (d?.recentHacks || d?.result?.recentHacks || []).slice(0, 6);
        if (hacks.length) {
            const lines = hacks.map((h: any, i: number) => `${i + 1}. ${h.name || "Incident"} — ${h.amount || "N/A"} (${h.date || "date N/A"})`);
            sections.push(`**Recent exploits**\n${lines.join("\n")}`);
        }
    }

    if (hasKey("getTrending")) {
        const d = last.getTrending as any;
        const topics = (d?.topics || d?.result?.topics || d?.trending || []).slice(0, 8);
        if (topics.length) {
            const lines = topics.map((t: any, i: number) => `${i + 1}. ${t.topic || t.title || t}`);
            sections.push(`**Trending topics**\n${lines.join("\n")}`);
        }
    }

    if (sections.length === 0) {
        const keys = Object.keys(last || {}).filter(Boolean);
        if (!keys.length) return null;

        const lines = keys.slice(0, 6).map((k) => {
            const node = last[k];
            const err = node?.error;
            const msg =
                typeof err === "string"
                    ? err
                    : err && typeof err === "object"
                      ? JSON.stringify(err)
                      : "No renderable output";
            return `- **${k}**: ${msg}`;
        });
        sections.push(
            `I routed your question to specialist tools, but the live data sources didn’t return renderable results in time.\n\n**Details**\n${lines.join("\n")}\n\nTry again in a moment, or ask a narrower version (e.g., a single ticker, tx hash, or protocol name).`
        );
    }
    return stripInlineRagCitations(sections.join("\n\n"));
}

function slugKeyPart(input: string, maxLen = 48): string {
    const base = (input || "")
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, maxLen);
    return base || "q";
}

/** Normalized lower prompt for routing (shared by fastRouteTools + backfill guards). */
function routingNorm(prompt: string): string {
    return (prompt || "")
        .toLowerCase()
        .replace(/[?!.]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Remove UI-hostile meta lines that sometimes leak from prompts/models.
 */
function sanitizeAssistantText(s: string): string {
    if (!s) return s;
    const lines = s.split("\n");
    const filtered = lines.filter((line) => {
        const t = line.trim();
        if (!t) return true;
        // Never show these internal validation disclaimers in the UI.
        if (/^offline model summary\b/i.test(t)) return false;
        if (/not verified against a live web index/i.test(t)) return false;
        if (/not provided as liveweb is true/i.test(t)) return false;
        return true;
    });
    return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isDeploymentMetaIntent(prompt: string): boolean {
    const sNorm = routingNorm(prompt || "");
    if (!sNorm) return false;
    return (
        /\b(what|which)\s+chain\b/.test(sNorm) ||
        /\bchain\s*(id|id\s*is|id\s*number)\b/.test(sNorm) ||
        /\b(deploy|deployed|deployment)\b/.test(sNorm) ||
        /\b(contract|registry|spending\s+policy)\b.*\b(address|addr)\b/.test(sNorm) ||
        /\b(bnb\s+testnet|bsc\s+testnet|four\.?meme)\b/.test(sNorm)
    );
}

/**
 * Detect "about Kairos (this project/app)" questions and route them to RAG + product explainer,
 * not paid specialist tools.
 */
function isKairosProjectIntent(prompt: string): boolean {
    const sNorm = routingNorm(prompt || "");
    if (!sNorm) return false;
    // Project/meta intent should not require the word "kairos" — users ask "what chain is this deployed on?"
    // Keep this broad on purpose for demo UX.
    return /\bkairos\b/.test(sNorm) || isDeploymentMetaIntent(sNorm);
}

/**
 * User wants live chain data (blocks / gas / activity), not generic web docs.
 * Keep in sync with getChainPulse routing in fastRouteTools.
 */
function wantsBnbTestnetChainPulseIntent(sNorm: string): boolean {
    const pulseTerms =
        /\b(pulse|activity|recent\s+blocks?|last(?:\s+\d{1,2})?\s+blocks?|block\s+height|network\s+stats?|gas|base\s*fee|chain\s+liveness|on[-\s]?chain|transactions?|tx\s+counts?|native\s+bnb|moving\s+on[-\s]?chain|liveness|healthy)\b/;
    return (
        ((/\bbnb\b|\bbsc\b|\bfour\.?meme\b|\btestnet\b/.test(sNorm) && pulseTerms.test(sNorm)) ||
            /\b(pulse|chain\s+activity|on[-\s]?chain\s+pulse)\b.*\b(bnb|bsc|testnet|four\.?meme)\b/.test(sNorm) ||
            /\bwhat'?s\s+happening\s+on\s+(the\s+)?(bnb|bsc)\s+chain\b/.test(sNorm) ||
            /\b(live\s+)?chain\s+pulse\b/.test(sNorm)) &&
        !isDeploymentMetaIntent(sNorm)
    );
}

function pulseToolDataSucceeded(node: any): boolean {
    return !!(node && !node.error && (node.chainId != null || node.latestBlock != null));
}

function fastRouteTools(prompt: string): RoutedToolCall[] {
    const q = (prompt || "").trim();
    const t = q;
    const s = q.toLowerCase();
    const sNorm = routingNorm(q);
    const tools: RoutedToolCall[] = [];

    if (!t) return [];

    // Pure greetings should NOT trigger paid specialist agents.
    // Keep greetings lightweight + relevant, and avoid confusing "agent active" UX for "hey/hi".
    const GREETING_ONLY =
        /^\s*(hi|hey|hello|gm|good\s+morning|good\s+afternoon|good\s+evening|thanks|thank\s+you|ty|yo)(\s*[,.!])*$/i;
    const isPureGreeting = GREETING_ONLY.test(t) && t.length <= 64;

    const add = (name: string, args: any) => {
        const sig =
            name === "getPriceData"
                ? String((args as any)?.symbol || "").toLowerCase()
                : name === "getProtocolStats"
                  ? String((args as any)?.protocol || "").toLowerCase()
                  : name === "getChainAccount"
                    ? String((args as any)?.address || "").toLowerCase()
                    : name === "getChainPulse"
                      ? String((args as any)?.depth ?? "5")
                      : name === "searchWeb"
                      ? String((args as any)?.query || "").toLowerCase()
                      : name === "getNews"
                        ? `${String((args as any)?.category || "all")}:${String((args as any)?.query || "").toLowerCase()}`
                        : name === "getYields"
                          ? JSON.stringify(args || {})
                          : "";
        const key = `${name}:${slugKeyPart(sig || name)}`;
        if (!tools.some((t) => t.key === key)) tools.push({ key, name, args });
    };

    if (isPureGreeting) return [];

    const KNOWN_TICKERS = new Set([
        "btc","eth","sol","bnb","xrp","ada","doge","dot","avax","matic","pol","link","ltc","bch","atom","near","op","arb","usdc","usdt","dai","wbtc","weth","crv","aave","uni","mkr","ldo","grt","snx","inj","tia","sei","sui","apt","ondo",
    ]);

    const mentionedTickers = Array.from(
        new Set(
            (sNorm.match(/\b[a-z]{2,10}\b/g) || [])
                .filter((t) => KNOWN_TICKERS.has(t))
        )
    );

    // Bridges / cross-chain
    if (/\bbridge(s|ing)?\b|\bcross[-\s]?chain\b|\bmove\s+assets?\b/.test(sNorm)) {
        add("getBridges", {});
    }

    // Price / ATH
    const parenSym = (q.match(/\(([A-Za-z0-9]{2,10})\)/)?.[1] || "").trim();
    const priceMatch = sNorm.match(
        /\bprice\b.*\bof\b\s+([a-z0-9]{2,10})\b|\bhow\s+much\s+is\b\s+([a-z0-9]{2,10})\b|\bcurrent\s+price\b.*\b([a-z0-9]{2,10})\b|\bath\b.*\b([a-z0-9]{2,10})\b|\ball[-\s]?time\s+high\b.*\b([a-z0-9]{2,10})\b/
    );
    const sym = (parenSym || priceMatch?.[1] || priceMatch?.[2] || priceMatch?.[3] || priceMatch?.[4] || priceMatch?.[5] || "").trim();
    if (sym) add("getPriceData", { symbol: sym });

    // Explicit ticker mentions (even without the word "price")
    if (!sym && mentionedTickers.length === 1) {
        add("getPriceData", { symbol: mentionedTickers[0] });
    }

    // Sprint testnet — live chain pulse (JSON-RPC)
    const wantsPulse = wantsBnbTestnetChainPulseIntent(sNorm);
    if (wantsPulse) {
        const dMatch = sNorm.match(/\b(?:last|past|recent)\s+(\d{1,2})\s+blocks?\b/);
        const depth = dMatch ? Math.min(20, Math.max(1, parseInt(dMatch[1], 10))) : 5;
        add("getChainPulse", { depth });
    }

    // (Removed) Legacy HashKey token context.

    // News
    if (/\b(latest|breaking|news|headlines)\b/.test(sNorm)) {
        add("getNews", { category: /\bbreaking\b/.test(sNorm) ? "breaking" : /\bdefi\b/.test(sNorm) ? "defi" : /\bbitcoin\b|\bbtc\b/.test(sNorm) ? "bitcoin" : "all" });
    }

    // "What's going on" + market pulse questions
    if (
        /\b(market|crypto)\b.*\b(condition|conditions|outlook|environment|situation)\b/.test(sNorm) ||
        /\bmarket\s+sentiment\b|\bmacro\b|\bregulation\b|\bsec\b|\betf\b|\bwhat\s+happened\b|\bwhy\s+is\b|\bdumping\b|\bpumping\b|\bcrash(ed|ing)?\b|\brally\b/.test(sNorm) ||
        /\b(current|today|right\s+now)\b.*\b(crypto|market)\b/.test(sNorm)
    ) {
        add("searchWeb", { query: q });
        add("getNews", { category: /\bbreaking\b/.test(sNorm) ? "breaking" : /\bdefi\b/.test(sNorm) ? "defi" : /\bbitcoin\b|\bbtc\b/.test(sNorm) ? "bitcoin" : "all" });
        add("getPriceData", { symbol: "btc" });
        add("getPriceData", { symbol: "eth" });
        add("getPriceData", { symbol: "bnb" });
    }

    // Oracle (company vs on-chain oracle) — web research first (never hijack chain-pulse RPC questions)
    if (/\boracle\b/.test(sNorm) && !/\b0x[a-f0-9]{40}\b/.test(q) && !wantsBnbTestnetChainPulseIntent(sNorm)) {
        add("searchWeb", { query: q });
        add("getNews", { query: "oracle", category: "all" as any });
    }

    const wantsYields = /\byield(s)?\b|\bapy\b|\bstake\b|\bstaking\b|\bearn\b/.test(sNorm);

    if (wantsYields) {
        const m = sNorm.match(/\b(usdc|usdt|dai|eth|btc|sol|bnb)\b/);
        add("getYields", m ? { asset: m[1].toUpperCase() } : {});
    }

    // Protocol stats
    if (/\btvl\b|\bfees\b|\brevenue\b|\bprotocol\b/.test(sNorm)) {
        const m = sNorm.match(/\b(aave|uniswap|lido|compound|curve|maker|makerdao)\b/);
        if (m?.[1]) add("getProtocolStats", { protocol: m[1] });
    }

    // Perps
    if (/\bperp(s)?\b|\bfunding\b|\bopen\s+interest\b|\boi\b/.test(sNorm)) {
        add("getGlobalPerpStats", {});
    }

    // Tokenomics (avoid the old "first word in sentence" trap)
    if (/\btokenomics\b|\bunlock(s)?\b|\bemission(s)?\b|\bcirculating\s+supply\b|\btotal\s+supply\b|\bfdv\b/.test(sNorm)) {
        const explicit = (sNorm.match(/\b([a-z]{2,10})\b\s+(tokenomics|unlock|emissions?|supply|fdv)\b/)?.[1] || "").trim();
        const tick = mentionedTickers[0];
        const picked = (explicit && KNOWN_TICKERS.has(explicit) ? explicit : tick) || "";
        if (picked) add("getTokenomics", { symbol: picked.toUpperCase() });
    }

    // Hacks
    if (/\bhack(s)?\b|\bexploit(s)?\b|\bsecurity\b|\bbreach\b/.test(sNorm)) {
        add("getHacks", {});
    }

    // Trending
    if (/\btrending\b|\bwhat'?s\s+hot\b/.test(sNorm)) {
        add("getTrending", {});
    }

    // DEX volumes
    if (/\bdex\b|\bdex(es)?\s+volume\b|\bspot\s+volume\b/.test(sNorm)) {
        add("getDexVolumes", {});
    }

    // EVM address questions
    const evm = q.match(/\b0x[a-f0-9]{40}\b/i)?.[0];
    if (evm) add("getChainAccount", { address: ethers.getAddress(evm) });

    // Safety net: never return an empty tool plan for a non-empty user message.
    if (!isPureGreeting && tools.length === 0 && t.length >= 1) {
        if (t.length >= 6) {
            add("searchWeb", { query: q });
            add("getNews", { category: "all" });
        } else {
            add("getNews", { category: "all" });
        }
    }

    return tools;
}

export function getOracleQueryCount(): number {
    return oracleQueryCount;
}

export function getScoutQueryCount(): number {
    return scoutQueryCount;
}

export function getNewsScoutQueryCount(): number {
    return newsScoutQueryCount;
}

export function getYieldOptimizerQueryCount(): number {
    return yieldOptimizerQueryCount;
}


// Function to handle protocol stats queries
async function handleGetProtocolStats(
    protocol: string,
    receiptSink?: (agentId: string, txHash: string) => void
): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 📊 Getting protocol stats for: ${protocol}...`);

    const payP = createProtocolPayment(`protocol:${protocol}`);
    void payP.then((h) => { if (h) receiptSink?.("protocol", h); }).catch(() => {});
    const stats = await defillama.getProtocolStats(protocol);

    if (!stats) {
        return { data: JSON.stringify({ error: `Could not find protocol: ${protocol}. Try: aave, uniswap, lido, compound, curve, makerdao` }) };
    }

    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);

    return {
        data: JSON.stringify({
            name: stats.name,
            category: stats.category,
            symbol: stats.symbol,
            tvl: stats.tvl,
            tvlChange24h: stats.tvlChange24h,
            mcap: stats.mcap,
            fees24h: stats.fees24h,
            fees7d: stats.fees7d,
            fees30d: stats.fees30d,
            revenue24h: stats.revenue24h,
            revenue7d: stats.revenue7d,
            chains: stats.chains.slice(0, 8),
            url: stats.url
        }),
        txHash
    };
}

// Function to handle bridges queries
async function handleGetBridges(receiptSink?: (agentId: string, txHash: string) => void): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 🌉 Getting bridge volumes...`);

    const bridges = await defillama.getBridges();

    if (!bridges || bridges.length === 0) {
        return { data: JSON.stringify({ error: "Could not fetch bridge data. Try again later." }) };
    }

    // Only pay once we have real data to return
    const payP = createBridgesPayment(`bridges`);
    void payP.then((h) => { if (h) receiptSink?.("bridges", h); }).catch(() => {});
    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);

    return {
        data: JSON.stringify({
            count: bridges.length,
            topBridges: bridges.slice(0, 8).map((b: any) => ({
                name: b.displayName,
                tvl: b.tvl,
                chains: b.chains?.slice(0, 5),
            })),
            note: "TVL-ranked bridge protocols from DeFiLlama. Volume data from bridges.llama.fi requires a paid plan."
        }),
        txHash
    };
}

// DEX volume agent
async function handleGetDexVolumes(chain?: string, receiptSink?: (agentId: string, txHash: string) => void) {
    const payP = createDexVolumesPayment(chain ? `dex:${chain}` : "dex:overview");
    void payP.then((h) => { if (h) receiptSink?.("dex-volumes", h); }).catch(() => {});
    const data = chain ? await defillamaDex.getDexVolumeByChain(chain) : await defillamaDex.getDexVolumeOverview();
    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);
    return { data: JSON.stringify(data || { error: "Could not fetch DEX volumes" }), txHash };
}

// Chain Scout: basic EVM account facts
async function handleGetChainAccount(address: string, receiptSink?: (agentId: string, txHash: string) => void) {
    const cfg = loadFourmemeChainConfigFromEnv();
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
    const payP = createChainScoutPayment(`acct:${address}`);
    void payP.then((h) => { if (h) receiptSink?.("chain-scout", h); }).catch(() => {});
    const [bal, nonce, code] = await Promise.all([
        provider.getBalance(address).catch(() => 0n),
        provider.getTransactionCount(address).catch(() => 0),
        provider.getCode(address).catch(() => "0x"),
    ]);
    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);
    return {
        data: JSON.stringify({
            address,
            balanceBnb: ethers.formatEther(bal),
            nonce,
            isContract: code !== "0x",
        }),
        txHash,
    };
}

async function handleGetChainPulse(
    depthArg: number | undefined,
    receiptSink?: (agentId: string, txHash: string) => void
): Promise<{ data: string; txHash?: string }> {
    const depth = Math.min(20, Math.max(1, depthArg ?? 5));
    console.log(`[Groq] ⛓️ BNB testnet chain pulse (depth=${depth})...`);
    const cfg = loadFourmemeChainConfigFromEnv();
    const payP = createChainScoutPayment(`pulse:${depth}`);
    void payP.then((h) => { if (h) receiptSink?.("chain-scout", h); }).catch(() => {});
    try {
        const pulse = await fetchChainPulse({ cfg, depth });
        const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);
        return { data: JSON.stringify(pulse), txHash };
    } catch (e: any) {
        const msg = String(e?.message || e || "rpc_error");
        return {
            data: JSON.stringify({
                error: msg,
                hint: "Verify FOURMEME_RPC_URL(S) and FOURMEME_CHAIN_ID (97) in kairos-backend/.env.",
            }),
        };
    }
}

function deploymentFactsText(): string {
    const chainId = Number(process.env.FOURMEME_CHAIN_ID || process.env.BSC_CHAIN_ID || "97") || 97;
    const rpc =
        (process.env.FOURMEME_RPC_URLS || process.env.FOURMEME_RPC_URL || process.env.BSC_RPC_URLS || process.env.BSC_RPC_URL || "")
            .split(",")[0]
            ?.trim() || "(not set)";
    const registry = (process.env.KAIROS_AGENT_REGISTRY_EVM_ADDRESS || "").trim() || "(not set)";
    const policy = (process.env.KAIROS_SPENDING_POLICY_EVM_ADDRESS || "").trim() || "(not set)";
    const perQuery = (process.env.KAIROS_DEFAULT_AGENT_PRICE_BNB || "0.0005").trim();
    const a2a = (process.env.KAIROS_A2A_PRICE_BNB || "0.00025").trim();
    return [
        "DEPLOYMENT FACTS (authoritative for this app instance):",
        `- Network: BNB Chain Testnet (chainId ${chainId})`,
        `- RPC: ${rpc}`,
        `- AgentRegistry: ${registry}`,
        `- SpendingPolicy: ${policy}`,
        `- Pricing: ${perQuery} BNB per agent call; ${a2a} BNB per A2A`,
    ].join("\n");
}

const SYSTEM_PROMPT_COMPACT = `You are Kairos (Four.meme AI Sprint build). Choose the right tools, then answer concisely using tool results.

Identity:
- “Kairos” refers to THIS app: an AI agentic marketplace and on-chain receipt demo built for the Four.meme AI Sprint. If the user asks “what is Kairos?” explain the product (agents, registry, spending policy, receipts, Chain Scout pulse), not the Greek word.
- Only explain the Greek word “kairos” if the user explicitly asks for the etymology/definition/meaning of the word.

${deploymentFactsText()}

Tool routing:
- Prices/ATH/market cap: getPriceData
- Headlines: getNews
- DeFi yields: getYields
- **Chain Scout (EVM native)**: getChainPulse = live **testnet head block**, **per-block tx counts**, **EIP-1559 base fee** (when RPC returns it), **gas-used ratio**, **native BNB** approximated as Σ **tx.value** over recent blocks (chainId **97**). getChainAccount = **native BNB balance**, **nonce**, **EOA vs contract** for any **0x** on the same RPC.
- “Explain / analyze / review my wallet” + 0x uses getChainAccount; the app may append grounded risks + next actions.
- DEX volumes (per chain): getDexVolumes
- Bridges/cross-chain: getBridges
- Protocol TVL/fees: getProtocolStats
- Perps: getGlobalPerpStats / getPerpMarkets
- Tokenomics: getTokenomics
- Hacks: getHacks
- Trending: getTrending
- Research / “why / what happened / macro”: searchWeb (live index when TAVILY_API_KEY or BRAVE_SEARCH_API_KEY is configured; otherwise offline summary)

Rules:
- If the user asks meta/deployment questions like “what chain are you deployed on?” answer from **DEPLOYMENT FACTS** (do NOT use web search, and do NOT hallucinate other chains).
- Never mention internal payment plumbing.
- Never invent live prices, TVL, or headlines: if you didn’t get numbers from tools, don’t fabricate them.
- Keep answers moderate length: ~6–12 lines, structured bullets + 1 short paragraph if useful.
- If tools error, be honest about what couldn't be verified and what to try next (short).`;

const SYSTEM_PROMPT_VERBOSE = `You are Kairos, the premier AI agentic marketplace built for the Four.meme AI Sprint.
You facilitate a multi-agent economy where agents can coordinate with auditable on-chain receipts (demo uses native BNB value transfers).

**Identity (CRITICAL):**
- “Kairos” refers to THIS product/app (agentic marketplace + on-chain receipts). If the user asks “what is Kairos?” or “what does this app do?”, answer about the product.
- Only discuss the Greek word “kairos” if the user explicitly asks for the word’s meaning/etymology (e.g., “what does kairos mean in Greek?”).

${deploymentFactsText()}

**ROUTING (CRITICAL):**
- Only the tools you actually call determine which specialist answered. Do not pretend to be "Price Oracle" unless you called getPriceData.
- For deployment/meta questions (“what chain is this deployed on?”, contract addresses, chainId): answer from **DEPLOYMENT FACTS** above. Do not use web search. Do not mention unrelated chains.
- For **"why is X dumping/pumping?", market analysis, current events, macroeconomic or regulatory explainers**: use **searchWeb** (live web index when TAVILY_API_KEY / BRAVE_SEARCH_API_KEY is configured; otherwise it is an offline model summary) — not getNews alone.
- For **crypto news headlines, "latest crypto news", breaking stories**: call **getNews** (RSS headlines from major outlets).
- For **BNB testnet chain pulse** (recent blocks, tx counts, base fee, native BNB moved in tx.value): call **getChainPulse** (optional depth 1–20).
- For **EVM account facts** (balance/nonce/contract detection): call **getChainAccount** with an 0x address.
- For **“explain my wallet” / analyze this address / risks** (with an 0x): call **getChainAccount**; the deployment adds a grounded **Risks** + **Next actions** section from that output.
- For **prices, ATH, market cap, "how much is X"**: call **getPriceData**.
- For **DEX volumes / top DEXs**: call **getDexVolumes**.
- For **"which bridge", "how to bridge", "bridge ETH to BNB", "convert across chains", "cross-chain transfer", "move funds between chains"**: call **getBridges** to surface real bridge options, then answer using that data.
- For **simple greetings** ("hi", "hey", "hello", "good morning", thanks): keep the reply warm and short; the system may still fetch a tiny **headline pulse** for context — do not contradict live headlines if present.

**IMPORTANT CONTEXT:**
- You operate exclusively in the crypto/blockchain/DeFi space.
- Prefer precise EVM terminology (EOA/contract, gas, wei/ether units, chainId=97).

**CHAIN SCOUT — infrastructure specialist (not a generic “block explorer bot”):**
- Answers about **testnet liveness** (head block, congestion signal, recent activity) must come from **getChainPulse** JSON: **latestBlock**, **latestBaseFeeGwei** (gas price signal when present), **blocks[]** (number, txCount, gasUsedRatio, nativeMoved), **chainId**, **rpcHost** hint.
- Answers about **a specific address** on this network use **getChainAccount**: **balanceBnb** (native), **nonce**, **isContract** — always tie numbers to **chainId 97** when the tools say so.
- If the user asks “**what’s gas**”, “**current block**”, “**network pulse**”, or “**is this address an EOA**” for BNB testnet, route to **getChainPulse** and/or **getChainAccount** as appropriate; do not substitute generic web search for those RPC-backed facts.

**On-chain payments (NEVER mention in responses):**
- Payments happen automatically behind the scenes — the UI shows them as badges.
- **NEVER** include any sentence about payments, amounts, "paid", "received", or "earned" in your response text. The payment UI handles disclosure.
- Do not add any payment footnote, receipt line, or financial disclosure at the end of responses.

**Your Capabilities:**
- PRICE ORACLE: Real-time prices for any crypto (BNB, USDC, BTC, ETH, etc.) via CoinGecko.
- CHAIN SCOUT: live **block height & pulse** (getChainPulse: base fee / gas signal, tx counts, native BNB in tx.value over a block window) plus **per-address** native balance, nonce, and contract detection (getChainAccount) on **chainId 97** via the deployment’s RPC.
- NEWS SCOUT: Real-time crypto news and sentiment analysis.
- PERP STATS: Perpetual futures funding rates, open interest, and volume.
- PROTOCOL STATS: DeFi protocol TVL, fees, and revenue via DeFiLlama.
- BRIDGE MONITOR: Top cross-chain bridges by TVL, supported chains, and how to bridge between networks.
- DEX VOLUMES: DEX volume overview (per chain / top DEXs) via DeFiLlama.

**Special Data Handling:**
- ALL-TIME HIGH (ATH): When using the Price Oracle, always report the ATH and the date it was reached if available. The user expects professional, 'top tier' financial responses.
- Historical context: If the current price is significantly below the ATH, mention the percentage drawdown.

**Handling Tool Failures & Truthfulness (STRICT):**
- If tools return valid structured numbers (prices/TVL/etc.), treat those as authoritative for this response.
- If tools are missing/errored for a factual claim, **do not fabricate** that claim; say what you can/can't verify and the fastest next check (one short sentence).
- If searchWeb indicates offline mode (liveWeb:false), do not pretend you browsed live pages.
- Keep apologies minimal; prioritize actionable next steps.

**Standard Formatting:**
- Be concise but thorough. Users pay for every query.
- Always provide accurate, up-to-date information. Cite sources when relevant.`;

// Default back to full/verbose responses unless explicitly set to compact.
const SYSTEM_PROMPT =
    (process.env.KAIROS_PROMPT || "verbose").toLowerCase().startsWith("c")
        ? SYSTEM_PROMPT_COMPACT
        : SYSTEM_PROMPT_VERBOSE;

// Function declaration for price oracle
const getPriceDataFunction = {
    name: "getPriceData",
    description: "Get real-time cryptocurrency price data. Use this when users ask about crypto prices, market caps, or 24h changes. Supports: bitcoin, ethereum, solana, usdc, usdt, bnb, xrp, ada, doge, xpl, arb, op, sui, and 100+ more tokens.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            symbol: {
                type: SchemaType.STRING,
                description: "The cryptocurrency symbol or name, e.g., 'bitcoin', 'ethereum', 'btc', 'eth', 'sol', 'xpl'",
            },
        },
        required: ["symbol"],
    },
};

// Function declaration for web search
const searchWebFunction = {
    name: "searchWeb",
    description:
        "Research the public web for fresh context. Prefer this for 'why / what happened / macro / regulation' questions. " +
        "When `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY` is configured, this uses a real web index (snippets + URLs). " +
        "Otherwise it falls back to an offline model summary (still useful, but not a live crawl). " +
        "Use getNews for quick RSS headline lists.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            query: {
                type: SchemaType.STRING,
                description: "The search query to look up on the web",
            },
        },
        required: ["query"],
    },
};

// Function declaration for protocol stats
const getProtocolStatsFunction = {
    name: "getProtocolStats",
    description: "Get detailed stats for a DeFi protocol including TVL, fees, revenue. Use when users ask about protocol metrics like 'What's Aave's TVL?' or 'Uniswap fees?'. Supports: aave, uniswap, lido, makerdao, compound, curve, etc.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            protocol: {
                type: SchemaType.STRING,
                description: "The protocol name (e.g., 'aave', 'uniswap', 'lido', 'compound')",
            },
        },
        required: ["protocol"],
    },
};

// Function declaration for bridges
const getBridgesFunction = {
    name: "getBridges",
    description: "Get top cross-chain bridges ranked by TVL. Use this whenever users ask: 'which bridge should I use?', 'how do I bridge ETH to BNB?', 'what bridges support BNB Chain?', 'how to convert ETH to BNB', 'move funds to BNB Chain', 'cross-chain transfer options', or any question about bridging assets between blockchains. Also use for bridge volume or activity questions.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {},
        required: [],
    },
};

// Function declaration for hacks
const getHacksFunction = {
    name: "getHacks",
    description: "Get recent DeFi hacks and exploits database. Shows protocol name, amount lost, and attack type. Use when users ask about security incidents or recent exploits.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {},
        required: [],
    },
};

// Function declaration for crypto news
const getNewsFunction = {
    name: "getNews",
    description:
        "Get recent crypto news headlines from major outlets (RSS aggregation). Use for: 'latest crypto news', 'what's happening in crypto', 'breaking news', category filters (bitcoin, defi, breaking). For long-form 'why is the market moving' analysis, prefer searchWeb.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            query: {
                type: SchemaType.STRING,
                description: "Optional search query to filter news by topic (e.g., 'solana', 'ethereum', 'regulatory')"
            },
            category: {
                type: SchemaType.STRING,
                enum: ["all", "bitcoin", "defi", "breaking"],
                description: "News category to filter by. Use 'breaking' for urgent news, 'bitcoin' for BTC-focused, 'defi' for DeFi news."
            }
        },
        required: [],
    },
};

// Function declaration for trending topics
const getTrendingFunction = {
    name: "getTrending",
    description: "Get trending topics in crypto with sentiment analysis. Shows what's being talked about most, with bullish/bearish/neutral sentiment. Use when users ask about 'what's trending', 'hot topics', or 'market sentiment'.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {},
        required: [],
    },
};

// Function declaration for yield optimizer
const getYieldsFunction = {
    name: "getYields",
    description: "Get DeFi yield opportunities from Lido, Yearn, Beefy, Curve, Aave, Pendle, and Turtle. Use when users ask about 'best yields', 'APY', 'where to earn', 'staking rates', 'vault yields', 'show more yields', 'lending rates', or mention any of these protocols by name (including 'Turtle'). Supports filtering by chain, asset, type, APY range (min/max), and pagination. IMPORTANT: Always explicitly state the total number of opportunities found (from the 'totalCount' field) in your response before listing them.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            chain: {
                type: SchemaType.STRING,
                description: "Filter by blockchain (ethereum, arbitrum, polygon, optimism, base)",
            },
            asset: {
                type: SchemaType.STRING,
                description: "Filter by asset (ETH, USDC, USDT, DAI, stETH, etc.)",
            },
            protocol: {
                type: SchemaType.STRING,
                enum: ["lido", "aave", "yearn", "beefy", "curve", "pendle", "turtle"],
                description: "Filter by specific protocol (Lido, Aave, Yearn, Beefy, Curve, Pendle, Turtle). Use when user asks about a specific protocol.",
            },
            type: {
                type: SchemaType.STRING,
                enum: ["staking", "lending", "vault", "lp", "fixed"],
                description: "Filter by yield type: staking (Lido), lending (Aave/Turtle), vault (Yearn/Beefy/Turtle), lp (Curve), fixed (Pendle)",
            },
            minApy: {
                type: SchemaType.NUMBER,
                description: "Minimum APY percentage to filter (e.g., 10 for 10%+)",
            },
            maxApy: {
                type: SchemaType.NUMBER,
                description: "Maximum APY percentage to filter (e.g., 20 for up to 20%). Use with minApy for range queries like '10-20% APY'.",
            },
            page: {
                type: SchemaType.NUMBER,
                description: "Page number for pagination (1-based). Use when user says 'show more' or 'next page'. Default is 1.",
            },
        },
        required: [],
    },
};

// Function declaration for tokenomics analyzer
const getTokenomicsFunction = {
    name: "getTokenomics",
    description: "Get tokenomics analysis for a cryptocurrency including supply data, vesting schedule, token unlocks, allocation breakdown, and inflation rate. Use when users ask about 'tokenomics', 'vesting', 'unlock schedule', 'token distribution', 'supply', or 'inflation' for a specific token. Supports ARB, OP, SUI, APT, ETH, SOL, and many more tokens.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            symbol: {
                type: SchemaType.STRING,
                description: "Token symbol (e.g., ARB, OP, SUI, APT, ETH, SOL)",
            },
        },
        required: ["symbol"],
    },
};



// Function declaration for Perp Global Stats
const getGlobalPerpStatsFunction = {
    name: "getGlobalPerpStats",
    description: "Get aggregated global perpetual market statistics including Total Open Interest and Total 24h Volume across all exchanges. Use when users ask about 'market open interest', 'total crypto perp volume', or general market activity levels.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {},
        required: [],
    },
};

// Function declaration for Perp Markets
const getPerpMarketsFunction = {
    name: "getPerpMarkets",
    description: "Get funding rates, open interest, and volume for specific perpetual markets. Use when users ask about 'funding rates for BTC', 'best funding yields', 'open interest on ETH', 'who has highest funding', 'negative funding rates'.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            symbol: {
                type: SchemaType.STRING,
                description: "Optional: Filter by token symbol (e.g. BTC, ETH, SOL). If omitted, returns top markets.",
            },
        },
        required: [],
    },
};

const getDexVolumesFunction = {
    name: "getDexVolumes",
    description: "Get top DEX volumes (overview or per-chain) via DeFiLlama. Use for DEX volume questions.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            chain: { type: SchemaType.STRING, description: "Optional chain name (e.g. ethereum, arbitrum)" },
        },
        required: [],
    },
};

const getChainAccountFunction = {
    name: "getChainAccount",
    description:
        "BNB testnet (EVM) account probe via the deployment RPC: native **BNB** balance (wei→ether), **transaction count (nonce)**, and **contract vs EOA** (code at address). Use for pasted **0x** addresses, 'what is my balance', 'is this a contract', or wallet explain/analyze flows on **testnet/mainnet as configured** (default demo: chainId 97).",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            address: { type: SchemaType.STRING, description: "EVM address starting with 0x" },
        },
        required: ["address"],
    },
};

const getChainPulseFunction = {
    name: "getChainPulse",
    description:
        "BNB testnet **live chain pulse** via JSON-RPC (deployment `FOURMEME_RPC_URLS` / `FOURMEME_RPC_URL`): **current head block height**, optional **EIP-1559 base fee** (native **gas price** signal), **per-block tx counts**, **block gas-used ratio**, and **native BNB** approximated as the sum of **tx.value** in each sampled block. Use for 'latest block', 'network health', 'gas', 'how busy is the chain', or 'show last N blocks' — not for CoinGecko token prices.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            depth: {
                type: SchemaType.NUMBER,
                description: "How many recent blocks to sample from chain head (1–20, default 5).",
            },
        },
        required: [],
    },
};

// Function declaration for Portfolio Rebalancer — multi-hop orchestration demo
const getPortfolioRebalanceFunction = {
    name: "getPortfolioRebalance",
    description: "Analyze portfolio holdings and recommend rebalancing strategy. This orchestrates MULTIPLE agents: Price Oracle (market prices), Yield Optimizer (best yields), and Chain Scout (on-chain context). Use when users ask about 'rebalance my portfolio', 'optimize holdings', 'portfolio strategy', 'where should I move funds', or 'best allocation'. Requires asset list.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            assets: {
                type: SchemaType.STRING,
                description: "Comma-separated asset symbols to analyze, e.g., 'ETH,USDC,BNB,BTC'",
            },
            riskProfile: {
                type: SchemaType.STRING,
                enum: ["conservative", "moderate", "aggressive"],
                description: "Risk tolerance: conservative (stable yields), moderate (balanced), aggressive (highest APY)",
            },
        },
        required: ["assets"],
    },
};

export interface ImageData {
    base64: string;
    mimeType: string;
}

export interface ConversationMessage {
    role: "user" | "model";
    content: string;
}

// Function to handle price oracle calls with payment tracking
async function handleGetPriceData(
    symbol: string,
    receiptSink?: (agentId: string, txHash: string) => void
): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 🔮 Calling Price Oracle for ${symbol}...`);

    const priceData = await fetchPrice(symbol);

    if (!priceData) {
        return { data: JSON.stringify({ error: `Could not find price data for ${symbol}` }) };
    }

    // Pay Oracle
    oracleQueryCount++;
    // Fire-and-forget payment: keep response fast, but publish receipt when ready.
    const payP = createOraclePayment(`price:${symbol}`);
    void payP.then((h) => { if (h) receiptSink?.("oracle", h); }).catch(() => {});
    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS); // opportunistic capture (doesn't slow much)

    return {
        data: JSON.stringify({
            symbol: priceData.symbol,
            name: priceData.name,
            price: priceData.price,
            currency: priceData.currency,
            change24h: priceData.change24h,
            marketCap: priceData.marketCap,
            volume24h: priceData.volume24h,
            ath: priceData.ath,
            athDate: priceData.athDate,
            lastUpdated: priceData.lastUpdated,
        }),
        txHash
    };
}

// Function to handle web search calls
async function handleSearchWeb(
    query: string,
    receiptSink?: (agentId: string, txHash: string) => void
): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 🌐 Searching web for: "${query}"...`);

    const searchResult = await runWebResearch(query);

    newsScoutQueryCount++;
    const payP = createNewsScoutPayment(`web:${searchResult.query || query}`);
    void payP.then((h) => { if (h) receiptSink?.("news", h); }).catch(() => {});
    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);

    return {
        data: JSON.stringify({
            query: searchResult.query,
            answer: searchResult.answer,
            liveWeb: searchResult.liveWeb,
            provider: searchResult.provider,
            fetchedAt: searchResult.fetchedAt,
            sources: searchResult.results.map((r) => ({
                title: r.title,
                url: r.url,
                content: r.content,
            })),
        }),
        txHash,
    };
}



// Function to handle hacks queries
async function handleGetHacks(): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] ⚠️ Getting recent DeFi hacks...`);

    const payP = withTimeoutOptional(createChainScoutPayment(`hacks`), PAYMENT_CAPTURE_TIMEOUT_MS);
    const hacks = await defillama.getHacks();

    if (!hacks) {
        return { data: JSON.stringify({ error: "Could not fetch hacks data. Try again later." }) };
    }

    // Pay Chain Scout for research
    const txHash = await payP;

    return {
        data: JSON.stringify({
            count: hacks.length,
            recentHacks: hacks.slice(0, 7).map(h => ({
                name: h.name,
                amount: h.amount,
                date: new Date(h.date).toLocaleDateString(),
                classification: h.classification,
                technique: h.technique,
                targetType: h.targetType,
                source: h.source,
                returnedFunds: h.returnedFunds,
                isBridgeHack: h.bridgeHack
            })),
        }),
        txHash
    };
}

// Function to handle crypto news queries
async function handleGetNews(
    query?: string,
    category?: string,
    receiptSink?: (agentId: string, txHash: string) => void
): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 📰 Getting crypto news... query="${query || 'none'}", category="${category || 'all'}"`);

    let news;

    if (category === "breaking") {
        news = await newsScout.getBreakingNews();
    } else if (category === "bitcoin") {
        news = await newsScout.getBitcoinNews();
    } else if (category === "defi") {
        news = await newsScout.getDefiNews();
    } else if (query) {
        news = await newsScout.searchNews(query);
    } else {
        news = await newsScout.getLatestNews();
    }

    if (!news || news.articles.length === 0) {
        return { data: JSON.stringify({ error: "Could not fetch news right now. Try again in a moment." }) };
    }

    newsScoutQueryCount++;
    const payP = createNewsScoutPayment(`news:${query || category || 'latest'}`);
    void payP.then((h) => { if (h) receiptSink?.("news", h); }).catch(() => {});
    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);

    return {
        data: JSON.stringify({
            articles: news.articles.slice(0, 8).map(a => ({
                title: a.title,
                description: a.description,
                link: a.link,
                source: a.source,
                timeAgo: a.timeAgo
            })),
            totalCount: news.totalCount,
            sources: news.sources,
            fetchedAt: news.fetchedAt
        }),
        txHash
    };
}

// Function to handle trending topics
async function handleGetTrending(): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 📈 Getting trending crypto topics...`);

    const payP = withTimeoutOptional(createNewsScoutPayment(`trending:topics`), PAYMENT_CAPTURE_TIMEOUT_MS);
    const trending = await newsScout.getTrendingTopics();

    if (!trending) {
        return { data: JSON.stringify({ error: "Could not fetch trending data. Try again later." }) };
    }

    // Pay News Scout agent
    newsScoutQueryCount++;
    const txHash = await payP;

    return {
        data: JSON.stringify({
            trending: [{
                topic: "BNB Chain DeFi Activity (BNB/USDC)",
                count: trending.trade_count,
                sentiment: parseFloat(trending.close) >= parseFloat(trending.open) ? "bullish" : "bearish",
                headline: `24h Volume: ${parseFloat(trending.base_volume).toLocaleString()} BNB | Avg Price: ${parseFloat(trending.avg).toFixed(4)} USDC`
            }],
            articlesAnalyzed: trending.trade_count,
            timeWindow: "24h (Real-time on-chain data)"
        }),
        txHash
    };
}

// Function to handle yield queries
async function handleGetYields(
    options?: { chain?: string; type?: string; minApy?: number; maxApy?: number; asset?: string; protocol?: string; page?: number },
    receiptSink?: (agentId: string, txHash: string) => void
): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 🌾 Getting DeFi yields...`, options);

    try {
        const page = options?.page || 1;
        const pageSize = 20; // Show 20 results per page

        let result;

        if (options?.asset) {
            result = await yieldOptimizer.getYieldsForAsset(options.asset);
            result = { opportunities: result, totalCount: result.length, fetchedAt: new Date().toISOString() };
        } else {
            result = await yieldOptimizer.getTopYields({
                chain: options?.chain,
                type: options?.type,
                protocol: options?.protocol,
                minApy: options?.minApy,
                maxApy: options?.maxApy,
                limit: 100 // Fetch up to 100 to support pagination
            });
        }

        if (!result || result.opportunities.length === 0) {
            return { data: JSON.stringify({ error: "No yield opportunities found matching your criteria. Try different filters." }) };
        }

        // Pay Yield Optimizer agent (only on first page) without blocking the response too long
        let txHash: string | undefined;
        if (page === 1) {
            yieldOptimizerQueryCount++;
            const payP = createYieldOptimizerPayment(`yields:${options?.chain || options?.asset || 'top'}`);
            void payP.then((h) => { if (h) receiptSink?.("yield", h); }).catch(() => {});
            txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);
        }

        // Calculate pagination
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        const paginatedOpportunities = result.opportunities.slice(startIndex, endIndex);
        const totalPages = Math.ceil(result.totalCount / pageSize);
        const hasMore = page < totalPages;

        return {
            data: JSON.stringify({
                opportunities: paginatedOpportunities.map(y => ({
                    protocol: y.protocol,
                    name: y.name,
                    asset: y.asset,
                    apy: y.apy,
                    tvl: y.tvl,
                    chain: y.chain,
                    risk: y.risk,
                    type: y.type,
                    url: y.url
                })),
                showing: paginatedOpportunities.length,
                totalCount: result.totalCount,
                page: page,
                totalPages: totalPages,
                hasMore: hasMore,
                nextPageHint: hasMore ? `Say "show more yields" or "page ${page + 1}" to see more` : null,
                fetchedAt: result.fetchedAt
            }),
            txHash
        };
    } catch (error) {
        console.error("[Gemini] Yield fetch error:", error);
        return { data: JSON.stringify({ error: "Failed to fetch yield data. Try again later." }) };
    }
}

// Track tokenomics usage for this session
let tokenomicsQueryCount = 0;

export function getTokenomicsQueryCount(): number {
    return tokenomicsQueryCount;
}

// Track perp stats usage
let perpStatsQueryCount = 0;

export function getPerpStatsQueryCount(): number {
    return perpStatsQueryCount;
}

// Function to handle Global Perp Stats
async function handleGetGlobalPerpStats(): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 📊 Getting global perp stats...`);

    try {
        // Pay Perp Stats Agent
        perpStatsQueryCount++;
        const txHash = await withTimeoutOptional(createPerpStatsPayment('global'), PAYMENT_CAPTURE_TIMEOUT_MS);

        const stats = await perpStatsService.getGlobalStats();
        return { data: JSON.stringify(stats), txHash };
    } catch (error) {
        console.error("Perp Stats Error:", error);
        return { data: JSON.stringify({ error: "Failed to fetch global perp stats." }) };
    }
}

// Function to handle Perp Markets
async function handleGetPerpMarkets(symbol?: string): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 📈 Getting perp markets${symbol ? ` for ${symbol}` : ''}...`);

    try {
        // Pay Perp Stats Agent
        perpStatsQueryCount++;
        const txHash = await withTimeoutOptional(createPerpStatsPayment(`markets:${symbol || 'all'}`), PAYMENT_CAPTURE_TIMEOUT_MS);

        let markets = await perpStatsService.getMarkets();

        if (symbol) {
            let s = symbol.toUpperCase();

            // Normalize common names to tickers
            const MAPPINGS: Record<string, string> = {
                "BITCOIN": "BTC",
                "ETHEREUM": "ETH",
                "SOLANA": "SOL",
                "RIPPLE": "XRP",
                "CARDANO": "ADA",
                "DOGECOIN": "DOGE",
                "AVALANCHE": "AVAX",
                "MATIC": "POL",
                "POLYGON": "POL"
            };
            if (MAPPINGS[s]) s = MAPPINGS[s];

            // Loose match: Allow "BTC" to match "BTC-USD", "BTCUSD", "BTC-PERP"
            markets = markets.filter(m => {
                const mSym = m.symbol.toUpperCase();
                return mSym === s || mSym.includes(s) || mSym.replace(/[-_]/g, '') === s;
            });

            if (markets.length === 0) {
                return { data: JSON.stringify({ error: `No perp markets found matching "${symbol}".` }), txHash };
            }
        } else {
            // If no symbol, return top 60 by OI to ensure diversity across exchanges (Hyperliquid dominates top 20)
            markets = markets.sort((a, b) => b.openInterestUsd - a.openInterestUsd).slice(0, 60);
        }

        return { data: JSON.stringify({ markets }), txHash };
    } catch (error) {
        console.error("Perp Stats Error:", error);
        return { data: JSON.stringify({ error: "Failed to fetch perp markets." }) };
    }
}




// Function to handle tokenomics analysis
async function handleGetTokenomics(
    symbol: string,
    receiptSink?: (agentId: string, txHash: string) => void
): Promise<{ data: string; txHash?: string }> {
    console.log(`[Gemini] 📊 Analyzing tokenomics for ${symbol}...`);

    const payP = createTokenomicsPayment(`tokenomics:${symbol}`);
    // Fire-and-forget payment: keep response fast, but publish receipt when ready.
    void payP.then((h) => {
        if (h) receiptSink?.("tokenomics", h);
    }).catch(() => {});
    const analysis = await tokenomicsService.analyzeTokenomics(symbol);

    if (!analysis) {
        return { data: JSON.stringify({ error: `Could not find tokenomics data for ${symbol}. Try a different token (ARB, OP, SUI, APT, ETH, SOL).` }) };
    }

    // Pay Tokenomics agent
    tokenomicsQueryCount++;
    const txHash = await withTimeoutOptional(payP, PAYMENT_CAPTURE_TIMEOUT_MS);

    // Format response for Gemini
    const hasUnlocks = analysis.upcomingUnlocks.length > 0;
    const isFullyCirculating = analysis.supply.percentUnlocked >= 99;

    return {
        data: JSON.stringify({
            symbol: analysis.symbol,
            name: analysis.name,
            supply: {
                circulating: analysis.supply.circulatingFormatted,
                total: analysis.supply.totalFormatted,
                max: analysis.supply.maxFormatted,
                percentUnlocked: analysis.supply.percentUnlocked + '%',
            },
            nextUnlock: analysis.nextUnlock ? {
                date: analysis.nextUnlock.date,
                amount: analysis.nextUnlock.amountFormatted,
                percentOfCirculating: analysis.nextUnlock.percentOfCirculating + '%',
                recipient: analysis.nextUnlock.recipient,
                riskLevel: analysis.nextUnlock.riskLevel,
            } : null,
            noUnlocksNote: !hasUnlocks ? (
                isFullyCirculating
                    ? "This token is fully circulating with no locked supply remaining."
                    : "Detailed unlock schedule data is not available for this token. Check sources like Token Unlocks or the project's official documentation for more info."
            ) : null,
            upcomingUnlocks: analysis.upcomingUnlocks.slice(0, 3).map(u =>
                `${u.date}: ${u.amountFormatted} (${u.percentOfCirculating}% of circ supply) - ${u.riskLevel}`
            ),
            allocations: analysis.allocations.map(a => `${a.category}: ${a.percentage}%`),
            inflation: analysis.inflation,
            fetchedAt: analysis.fetchedAt,
        }),
        txHash
    };
}

/**
 * Portfolio Rebalancer — Multi-Agent Orchestration Demo
 * Calls 3+ agents (Oracle, Yield, Chain Scout) and combines their data.
 * This triggers A2A payments: the primary orchestrating agent pays sub-agents.
 */
async function handleGetPortfolioRebalance(
    assets: string,
    riskProfile: "conservative" | "moderate" | "aggressive" = "moderate"
): Promise<{ data: string; txHashes: Record<string, string> }> {
    console.log(`[Gemini] 🔄 Portfolio Rebalancer: assets=${assets}, risk=${riskProfile}`);

    const assetList = assets.split(',').map(a => a.trim().toUpperCase()).filter(Boolean);
    if (assetList.length === 0) {
        return { data: JSON.stringify({ error: "Please provide at least one asset symbol" }), txHashes: {} };
    }

    const txHashes: Record<string, string> = {};

    // 1. Fetch prices for all assets in parallel (Oracle agent)
    const pricePromises = assetList.map(async (symbol): Promise<{ symbol: string; priceData: PriceData | null }> => {
        const priceData = await fetchPrice(symbol);
        return { symbol, priceData };
    });
    oracleQueryCount++;
    const payOracleP = createOraclePayment(`rebal:prices`);

    // 2. Get yield opportunities (Yield agent)
    yieldOptimizerQueryCount++;
    const payYieldP = createYieldOptimizerPayment(`rebal:yields`);
    const yieldsP = yieldOptimizer.getTopYields({ minApy: riskProfile === "aggressive" ? 5 : 2, limit: 15 });

    // 3. Get chain/account context (Chain Scout agent)
    scoutQueryCount++;
    const payScoutP = createChainScoutPayment(`rebal:chain`);

    // Wait for all data + payments
    const [prices, yields, oracleTx, yieldTx, scoutTx] = await Promise.all([
        Promise.all(pricePromises),
        yieldsP,
        withTimeoutOptional(payOracleP, PAYMENT_CAPTURE_TIMEOUT_MS),
        withTimeoutOptional(payYieldP, PAYMENT_CAPTURE_TIMEOUT_MS),
        withTimeoutOptional(payScoutP, PAYMENT_CAPTURE_TIMEOUT_MS),
    ]);

    if (oracleTx) txHashes["oracle"] = oracleTx;
    if (yieldTx) txHashes["yield"] = yieldTx;
    if (scoutTx) txHashes["chain-scout"] = scoutTx;

    // Build portfolio analysis
    const portfolioData = prices.map(({ symbol, priceData }) => ({
        symbol,
        currentPrice: priceData?.price ?? "N/A",
        change24h: priceData?.change24h ?? "N/A",
        marketCap: priceData?.marketCap ?? "N/A",
    }));

    // Filter yields by risk profile
    const apyThreshold = riskProfile === "conservative" ? 3 : riskProfile === "moderate" ? 5 : 10;
    const filteredYields = yields?.opportunities?.filter((y) => y.apy >= apyThreshold).slice(0, 5) || [];

    // Combine recommendations
    const recommendations = {
        riskProfile,
        assets: portfolioData,
        agentsUsed: ["oracle", "yield", "chain-scout"],
        yieldOpportunities: filteredYields.map((y) => ({
            protocol: y.protocol,
            chain: y.chain,
            asset: y.asset,
            apy: y.apy,
            tvl: y.tvl,
        })),
        yields: [],
        strategy: riskProfile === "conservative"
            ? "Focus on stable assets (USDC, USDT) with low-risk yields (3-5% APY)"
            : riskProfile === "moderate"
            ? "Balanced mix of volatile assets and yield-bearing positions (5-10% APY)"
            : "Maximize APY with higher volatility exposure (10%+ APY)",
        multiAgentNote: `This analysis was coordinated across multiple specialist agents for the Sprint demo (market data, DeFi yields, and chain/account context).`,
    };

    return { data: JSON.stringify(recommendations), txHashes };
}

export interface GenerateResponseResult {
    response: string;
    agentsUsed: string[];
    txHashes: Record<string, string>; // agentId -> txHash for on-chain payments
    a2aPayments?: A2APayment[];               // agent-to-agent sub-payments
    partial?: boolean;
    /** Populated when RAG retrieved corpus excerpts for this turn */
    ragSources?: RagSource[];
    /** Populated when searchWeb ran (URLs/snippets returned by provider). */
    webSources?: Array<{
        title: string;
        url: string;
        content: string;
        provider: string;
        liveWeb: boolean;
        fetchedAt: string;
    }>;
}

export async function generateResponse(
    prompt: string,
    imageData?: ImageData,
    conversationHistory?: ConversationMessage[],
    receiptSink?: (agentId: string, txHash: string) => void,
    opts?: { tone?: "trader" | "beginner" | "research" }
): Promise<GenerateResponseResult> {
    if (!groqReady) {
        // initGemini() is still called from index.ts for backwards compatibility.
        // If a deployment bypasses that, fail loudly with correct env hint.
        throw new Error("Groq not initialized. Set GROQ_API_KEY and restart.");
    }

    // Fast-path: avoid routing/paying agents for pure greetings.
    const GREETING_ONLY =
        /^\s*(hi|hey|hello|gm|good\s+morning|good\s+afternoon|good\s+evening|thanks|thank\s+you|ty|yo)(\s*[,.!])*$/i;
    if (!imageData && GREETING_ONLY.test((prompt || "").trim()) && (prompt || "").trim().length <= 64) {
        return {
            response:
                "Hey! What do you want to do?\n\n" +
                "- Ask a token price (e.g. “price of BTC”)\n" +
                "- Ask for crypto headlines (e.g. “latest crypto news”)\n" +
                "- Ask for yields (e.g. “best ETH staking yields”)\n" +
                "- Ask for chain pulse (e.g. “Sprint testnet pulse last 5 blocks”)\n",
            agentsUsed: [],
            txHashes: {},
            a2aPayments: [],
            partial: false,
        };
    }

    let ragSources: RagSource[] | undefined;
    let augmentedUserText = prompt || "";
    const wantsKairosProject = !imageData && isKairosProjectIntent(prompt || "");
    if (!imageData && ((prompt || "").trim().length >= 8 || wantsKairosProject)) {
        try {
            const rag = await retrieveRagAugmentation(prompt);
            if (rag) {
                augmentedUserText = `${rag.prefixText}\n\n${(prompt || "").trim()}`;
                ragSources = rag.sources;
            }
        } catch (e) {
            console.warn("[RAG] augmentation skipped:", e);
        }
    }

    // Track which agents are called
    const agentsUsed = new Set<string>();
    // Track tx hashes per agent
    const txHashes: Record<string, string> = {};
    let partial = false;
    // Reset A2A payments for this request
    currentA2APayments = [];
    let a2aRan = false;
    const startedAt = Date.now();
    // Best-effort latency cap:
    // Keep typical responses fast (<~5s end-to-end) by limiting tool execution time.
    // Increased timeouts for stability — Yield/DeFi tools need time to fetch from multiple sources
    const TOOL_BUDGET_MS = Number(process.env.KAIROS_TOOL_BUDGET_MS || 25000);
    const TOOL_TIMEOUT_MS = Number(process.env.KAIROS_TOOL_TIMEOUT_MS || 20000);

    const remainingMs = () => TOOL_BUDGET_MS - (Date.now() - startedAt);

    async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
        return await Promise.race([
            p,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout_after_${ms}ms`)), ms)),
        ]);
    }

    function wrapToolResult(raw: string) {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed !== "object" || parsed === null) return { result: parsed };
            return parsed;
        } catch {
            return { error: "Failed to parse tool result", raw };
        }
    }

    function firstToolNode(last: Record<string, any>, toolName: string): any | undefined {
        const keys = toolResultKeys(last, toolName);
        for (const k of keys) {
            const node = last[k];
            if (node && !node.error) return node;
        }
        for (const k of keys) {
            const node = last[k];
            if (node) return node;
        }
        return undefined;
    }

    function collectWebSources(last: Record<string, any>): GenerateResponseResult["webSources"] | undefined {
        const node = firstToolNode(last, "searchWeb");
        const sources = Array.isArray(node?.sources) ? node.sources : [];
        if (!sources.length) return undefined;
        const provider = String(node?.provider || "");
        const liveWeb = !!node?.liveWeb;
        const fetchedAt = String(node?.fetchedAt || "");
        return sources
            .filter((s: any) => s && (s.url || s.title || s.content))
            .slice(0, 8)
            .map((s: any) => ({
                title: String(s.title || "Source"),
                url: String(s.url || ""),
                content: String(s.content || "").slice(0, 900),
                provider,
                liveWeb,
                fetchedAt,
            }));
    }

    async function maybeRunA2A() {
        if (a2aRan) return;
        a2aRan = true;
        const usedAgents = Array.from(agentsUsed);
        if (usedAgents.length < 2) return;
        const primaryAgent = pickPrimaryAgent(usedAgents);
        const subAgents = usedAgents.filter((a) => a !== primaryAgent);
        if (subAgents.length === 0) return;
        console.log(`[A2A] 🤝 ${primaryAgent} coordinating with: ${subAgents.join(", ")}`);
        const a2aPromises = subAgents.map((subAgent) =>
            sendAgentToAgentPayment(primaryAgent, subAgent, `coord:${subAgent}`).catch((e) => {
                console.error(`[A2A] payment error:`, e);
                return undefined;
            })
        );
        await Promise.race([Promise.all(a2aPromises), new Promise<void>((r) => setTimeout(r, 12000))]);
    }

    async function executeToolCall(call: any): Promise<{ key: string; name: string; raw: string }> {
        const resultKey = typeof call?.key === "string" && call.key.trim() ? call.key : String(call?.name || "tool");

        // Global time budget check
        if (remainingMs() <= 0) {
            partial = true;
            return { key: resultKey, name: call.name, raw: JSON.stringify({ error: "Time budget exceeded" }) };
        }

        const perCallTimeout = Math.max(250, Math.min(TOOL_TIMEOUT_MS, remainingMs()));

        try {
            if (call.name === "getPriceData") {
                agentsUsed.add("oracle");
                const args = call.args as { symbol: string };
                const r = await withTimeout(handleGetPriceData(args.symbol, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["oracle"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "searchWeb") {
                agentsUsed.add("news");
                const args = call.args as { query: string };
                const r = await withTimeout(handleSearchWeb(args.query, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["news"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getProtocolStats") {
                agentsUsed.add("protocol");
                const args = call.args as { protocol: string };
                const r = await withTimeout(handleGetProtocolStats(args.protocol, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["protocol"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getBridges") {
                agentsUsed.add("bridges");
                const r = await withTimeout(handleGetBridges(receiptSink), perCallTimeout);
                if (r.txHash) txHashes["bridges"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getHacks") {
                agentsUsed.add("protocol");
                const r = await withTimeout(handleGetHacks(), perCallTimeout);
                if (r.txHash) txHashes["protocol"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getNews") {
                agentsUsed.add("news");
                const args = call.args as { query?: string; category?: string };
                const r = await withTimeout(handleGetNews(args.query, args.category, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["news"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getTrending") {
                agentsUsed.add("news");
                const r = await withTimeout(handleGetTrending(), perCallTimeout);
                if (r.txHash) txHashes["news"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getYields") {
                agentsUsed.add("yield");
                const args = call.args as { chain?: string; type?: string; minApy?: number; maxApy?: number; asset?: string; protocol?: string; page?: number };
                const r = await withTimeout(handleGetYields(args, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["yield"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getTokenomics") {
                agentsUsed.add("tokenomics");
                const args = call.args as { symbol: string };
                const r = await withTimeout(handleGetTokenomics(args.symbol, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["tokenomics"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getGlobalPerpStats") {
                agentsUsed.add("perp");
                const r = await withTimeout(handleGetGlobalPerpStats(), perCallTimeout);
                if (r.txHash) txHashes["perp"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getPerpMarkets") {
                agentsUsed.add("perp");
                const args = call.args as { symbol?: string };
                const r = await withTimeout(handleGetPerpMarkets(args.symbol), perCallTimeout);
                if (r.txHash) txHashes["perp"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getDexVolumes") {
                agentsUsed.add("dex-volumes");
                const args = call.args as { chain?: string };
                const r = await withTimeout(handleGetDexVolumes(args.chain, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["dex-volumes"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getChainAccount") {
                agentsUsed.add("chain-scout");
                const args = call.args as { address: string };
                const r = await withTimeout(handleGetChainAccount(args.address, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["chain-scout"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }
            if (call.name === "getChainPulse") {
                agentsUsed.add("chain-scout");
                const rawDepth = (call.args as { depth?: number })?.depth;
                const depth =
                    typeof rawDepth === "number" && Number.isFinite(rawDepth)
                        ? Math.min(20, Math.max(1, Math.floor(rawDepth)))
                        : undefined;
                const r = await withTimeout(handleGetChainPulse(depth, receiptSink), perCallTimeout);
                if (r.txHash) txHashes["chain-scout"] = r.txHash;
                return { key: resultKey, name: call.name, raw: r.data };
            }

            return { key: resultKey, name: call.name, raw: JSON.stringify({ error: `Unknown tool: ${call.name}` }) };
        } catch (e: any) {
            if (String(e?.message || "").includes("timeout_after_")) {
                partial = true;
                return { key: resultKey, name: call.name, raw: JSON.stringify({ error: "Tool timeout (partial response)", timeoutMs: perCallTimeout }) };
            }
            console.error(`[Gemini] Tool execution failed for ${call.name}:`, e);
            return { key: resultKey, name: call.name, raw: JSON.stringify({ error: `Tool execution failed: ${e?.message || String(e)}` }) };
        }
    }

    try {
        const t0 = Date.now();
        if (imageData) {
            return {
                response: "Image queries are temporarily disabled on the Groq model used by this deployment.",
                agentsUsed: [],
                txHashes: {},
                a2aPayments: [],
                partial: true,
                ragSources,
            };
        }

        // Fast mode: bypass Groq entirely for common, tool-first queries.
        // But: Kairos-project questions should go through RAG + product explainer, not specialist tools.
        if (FAST_MODE && !wantsKairosProject) {
            const routed = fastRouteTools(prompt || "");
            if (routed.length) {
                const lastToolResultsByName: Record<string, any> = {};
                await Promise.all(
                    routed.map(async (c) => {
                        const r = await executeToolCall(c);
                        lastToolResultsByName[r.key] = wrapToolResult(r.raw);
                    })
                );

                // Preserve the on-chain "A2A flow" demo in fast mode when multiple agents were used.
                const usedAgents = Array.from(agentsUsed);
                if (usedAgents.length >= 2) {
                    const primaryAgent = pickPrimaryAgent(usedAgents);
                    const subAgents = usedAgents.filter((a) => a !== primaryAgent);
                    console.log(`[A2A] 🤝 ${primaryAgent} coordinating with: ${subAgents.join(", ")}`);
                    const a2aPromises = subAgents.map((subAgent) =>
                        sendAgentToAgentPayment(primaryAgent, subAgent, `coord:${subAgent}`).catch((e) => {
                            console.error(`[A2A] payment error:`, e);
                            return undefined;
                        })
                    );
                    await Promise.race([Promise.all(a2aPromises), new Promise<void>((r) => setTimeout(r, 12000))]);
                }
                const rendered = renderFastFromTools(lastToolResultsByName);
                if (rendered) {
                    const responseTextOut = (
                        await composeFastToolAnswer(prompt || "", routed, lastToolResultsByName)
                    ).trim();
                    console.log(
                        `[FastMode] composed from tools in ${Date.now() - t0}ms (tools=${routed
                            .map((r) => r.name)
                            .join(",")})`
                    );
                    return {
                        response: sanitizeAssistantText(stripInlineRagCitations(responseTextOut)),
                        agentsUsed: Array.from(agentsUsed),
                        txHashes,
                        a2aPayments: currentA2APayments,
                        partial,
                        ragSources,
                        webSources: collectWebSources(lastToolResultsByName),
                    };
                }
            }
        }

        const toTool = (fn: any): GroqTool => ({
            type: "function",
            function: {
                name: fn.name,
                description: fn.description,
                parameters: fn.parameters,
            },
        });

        const tools: GroqTool[] = [
            toTool(getPriceDataFunction),
            toTool(searchWebFunction),
            toTool(getProtocolStatsFunction),
            toTool(getBridgesFunction),
            toTool(getHacksFunction),
            toTool(getNewsFunction),
            toTool(getTrendingFunction),
            toTool(getYieldsFunction),
            toTool(getTokenomicsFunction),
            toTool(getGlobalPerpStatsFunction),
            toTool(getPerpMarketsFunction),
            toTool(getDexVolumesFunction),
            toTool(getChainAccountFunction),
            toTool(getChainPulseFunction),
        ];

        const tone = (opts?.tone || (process.env.KAIROS_TONE as any) || "trader") as "trader" | "beginner" | "research";
        const toneBlock =
            tone === "beginner"
                ? "\n\nRESPONSE STYLE: Beginner-friendly. Explain terms briefly, add 1–2 safety checks, and end with a simple next step."
                : tone === "research"
                  ? "\n\nRESPONSE STYLE: Research mode. Be rigorous and source-backed. Prefer searchWeb/getNews where relevant and include a short **Sources** section with URLs/snippets. If liveWeb:false, label it as offline."
                  : "\n\nRESPONSE STYLE: Trader-grade. Be concise, numeric, structured; prioritize prices/levels/percentages, avoid fluff.";

        const messages: GroqChatMessage[] = [{ role: "system", content: `${SYSTEM_PROMPT}${toneBlock}` }];
        if (conversationHistory?.length) {
            for (const msg of conversationHistory) {
                if (msg.role === "user") messages.push({ role: "user", content: msg.content });
                else messages.push({ role: "assistant", content: msg.content });
            }
        }
        messages.push({ role: "user", content: augmentedUserText || (prompt || "").trim() });

        let turns = 0;
        const lastToolResultsByName: Record<string, any> = {};
        // Permanent fix: default to NO tool-calling on Groq to avoid HTTP 400 tool_use_failed.
        // Tool routing is handled deterministically by Fast Mode / heuristics above.
        let completion = await withRetry(() =>
            groqChatComplete({
                messages,
                tools: GROQ_TOOL_CALLING ? tools : undefined,
                toolChoice: GROQ_TOOL_CALLING ? "auto" : "none",
                temperature: 0.2,
                maxTokens: 650,
                timeoutMs: Math.min(GROQ_TIMEOUT_MS, Math.max(8000, remainingMs() + 5000)),
            })
        );
        console.log(
            `[Groq] first completion in ${Date.now() - t0}ms (toolCalls=${completion.toolCalls.length}, content=${completion.content ? "yes" : "no"}, toolCalling=${GROQ_TOOL_CALLING ? "on" : "off"})`
        );

        while (GROQ_TOOL_CALLING && completion.toolCalls.length > 0 && turns < 5) {
            turns++;
            // IMPORTANT: OpenAI-style tool calling requires an assistant message that contains `tool_calls`,
            // followed by one `tool` message per tool_call_id. Without this, models sometimes return empty final text.
            messages.push({ role: "assistant", tool_calls: completion.toolCalls });

            await Promise.all(
                completion.toolCalls.map(async (tc) => {
                    let args: any = {};
                    try {
                        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
                    } catch {
                        args = {};
                    }
                    const r = await executeToolCall({ name: tc.function.name, args });
                    lastToolResultsByName[r.key] = wrapToolResult(r.raw);
                    messages.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: r.raw,
                    });
                    return r;
                })
            );

            // Fast mode: skip the second Groq "write-up" call and render directly from tool outputs.
            if (FAST_MODE) {
                const rendered = renderFastFromTools(lastToolResultsByName);
                if (rendered) {
                    const routedForCompose: RoutedToolCall[] = completion.toolCalls.map((tc) => ({
                        key: tc.function.name,
                        name: tc.function.name,
                        args: {},
                    }));
                    const responseTextOut = (
                        await composeFastToolAnswer(prompt || "", routedForCompose, lastToolResultsByName)
                    ).trim();
                    await maybeRunA2A();
                    return {
                        response: sanitizeAssistantText(stripInlineRagCitations(responseTextOut)),
                        agentsUsed: Array.from(agentsUsed),
                        txHashes,
                        a2aPayments: currentA2APayments,
                        partial,
                        ragSources,
                        webSources: collectWebSources(lastToolResultsByName),
                    };
                }
            }

            // If we ran out of time budget, stop tool loop and let fallback logic handle it.
            if (remainingMs() <= 0) break;

            completion = await withRetry(() =>
                groqChatComplete({
                    messages,
                    tools,
                    toolChoice: "auto",
                    temperature: 0.2,
                    maxTokens: 650,
                    timeoutMs: Math.min(GROQ_TIMEOUT_MS, Math.max(8000, remainingMs() + 5000)),
                })
            );
            console.log(`[Groq] follow-up completion in ${Date.now() - t0}ms (turns=${turns}, toolCalls=${completion.toolCalls.length}, content=${completion.content ? "yes" : "no"})`);
        }

        // ─── Agent-to-Agent Sub-Payments ────────────────────────────────────────
        // Fire A2A payments with a short timeout window — if they settle within
        // 6s they're included in the response; otherwise they complete in background
        // and the frontend polls /receipts for the txHash.
        await maybeRunA2A();
        // ────────────────────────────────────────────────────────────────────────

        const responseText = completion.content || "";

        const finalText =
            responseText ||
            "I've processed the market data but am unable to generate a summary at this moment. You can see the raw data in the activity feed below.";
        const finalTextClean = stripInlineRagCitations(finalText);

        // If Gemini fails to produce final text, but we have deterministic tool output,
        // generate a high-quality fallback response for the most common demo tool (Price Oracle).
        const firstPrice = firstToolNode(lastToolResultsByName, "getPriceData");
        if (!responseText && firstPrice && !firstPrice.error) {
            const d = firstPrice as any;
            const sym = d.symbol || String((prompt || "").split(/\s+/).pop() || "").toUpperCase();
            const price = d.price != null ? `$${Number(d.price).toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "N/A";
            const change = d.change24h != null ? `${Number(d.change24h).toFixed(2)}%` : "N/A";
            const mcap = d.marketCap != null ? `$${Number(d.marketCap).toLocaleString()}` : "N/A";
            const vol = d.volume24h != null ? `$${Number(d.volume24h).toLocaleString()}` : "N/A";
            const ath = d.ath != null ? `$${Number(d.ath).toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "N/A";
            const athDate = d.athDate ? new Date(d.athDate).toLocaleDateString() : "N/A";

            return {
                response:
                    `The current price of **${d.name || sym} (${(d.symbol || sym).toUpperCase()})** is **${price} ${d.currency || "USD"}**.\n\n` +
                    `- **24h change**: ${change}\n` +
                    `- **Market cap**: ${mcap}\n` +
                    `- **24h volume**: ${vol}\n` +
                    `- **All-time high (ATH)**: ${ath} (reached ${athDate})\n\n` +
                    `**Last updated:** ${formatMarketLastUpdated(d.lastUpdated)}`,
                agentsUsed: Array.from(agentsUsed),
                txHashes,
                a2aPayments: currentA2APayments,
                partial: false,
                ragSources,
            };
        }

        // If Gemini returns empty text AND the Price Oracle tool errored/timed out,
        // return a clear, actionable message instead of the generic fallback.
        const firstPriceErr = firstToolNode(lastToolResultsByName, "getPriceData");
        if (!responseText && firstPriceErr?.error) {
            const e = firstPriceErr.error;
            const sym = String((prompt || "").match(/\b[A-Za-z0-9]{2,10}\b/g)?.slice(-1)?.[0] || "this token").toUpperCase();
            const isTimeout = typeof e === "string" && e.includes("timeout");
            const hint = isTimeout
                ? "The price feed timed out (CoinGecko can be slow). Please retry."
                : "The price feed had a temporary issue. Please retry.";
            return {
                response: sanitizeAssistantText(stripInlineRagCitations(`I couldn’t fetch a fresh price for **${sym}** right now. ${hint}`)),
                agentsUsed: Array.from(agentsUsed),
                txHashes,
                a2aPayments: currentA2APayments,
                partial: true,
                ragSources,
            };
        }

        // News: if the model returned empty text but we have articles, render them directly.
        const firstNews = firstToolNode(lastToolResultsByName, "getNews") as
            | { articles?: Array<{ title: string; source?: string; timeAgo?: string; link?: string }> }
            | undefined;
        if (!responseText && firstNews?.articles?.length) {
            const d = firstNews as { articles: Array<{ title: string; source?: string; timeAgo?: string; link?: string }> };
            const lines = d.articles.slice(0, 8).map((a, i) => {
                const src = a.source ? ` — ${a.source}` : "";
                const when = a.timeAgo ? ` (${a.timeAgo})` : "";
                return `${i + 1}. **${a.title}**${src}${when}`;
            });
            return {
                response: `### Latest crypto headlines\n\n${lines.join("\n\n")}`,
                agentsUsed: Array.from(agentsUsed),
                txHashes,
                a2aPayments: currentA2APayments,
                partial: false,
                ragSources,
            };
        }

        // Bridges: if the model returned empty text but we have deterministic bridge data, render it.
        if (!responseText && lastToolResultsByName.getBridges && !lastToolResultsByName.getBridges.error) {
            const d = lastToolResultsByName.getBridges as any;
            const bridges = Array.isArray(d?.bridges) ? d.bridges : Array.isArray(d?.result?.bridges) ? d.result.bridges : [];
            if (bridges.length) {
                const top = bridges.slice(0, 8).map((b: any, i: number) => {
                    const name = b.name || b.bridge || b.protocol || "Bridge";
                    const tvl = b.tvl != null ? `$${Number(b.tvl).toLocaleString()}` : undefined;
                    const chains = Array.isArray(b.chains) ? b.chains.slice(0, 6).join(", ") : undefined;
                    const bits = [tvl ? `TVL ${tvl}` : null, chains ? `Chains: ${chains}` : null].filter(Boolean).join(" · ");
                    return `${i + 1}. **${name}**${bits ? ` — ${bits}` : ""}`;
                });
                return {
                    response: sanitizeAssistantText(stripInlineRagCitations(`### Top bridges (by TVL)\n\n${top.join("\n\n")}`)),
                    agentsUsed: Array.from(agentsUsed),
                    txHashes,
                    a2aPayments: currentA2APayments,
                    partial,
                    ragSources,
                };
            }
        }

        const trimmed = (responseText || "").trim();
        const substantiveAnswer = trimmed.length >= 180;
        const clientPartial = partial && !substantiveAnswer;
        const baseOut = substantiveAnswer
            ? finalTextClean
            : clientPartial
                ? `${finalTextClean}\n\n**(Partial)** Some tools hit the time limit; try a shorter question or ask again.`
                : finalTextClean;
        const responseOut = stripInlineRagCitations(baseOut);

        // If Groq answered without invoking tools, backfill specialists so telemetry + UI stay honest.
        // When FAST_MODE is on, deterministic routing already ran first; skip this to avoid double-fetching.
        // When GROQ_TOOL_CALLING=1, the model may call searchWeb for a chain-pulse question — still inject RPC tools.
        const sNormBack = routingNorm(prompt || "");
        const pulseIntent = wantsBnbTestnetChainPulseIntent(sNormBack);
        const pulseDone = pulseToolDataSucceeded(firstMatchingToolNode(lastToolResultsByName, "getChainPulse"));
        const shouldToolBackfill =
            !FAST_MODE &&
            (prompt || "").trim().length >= 2 &&
            (agentsUsed.size === 0 || (pulseIntent && !pulseDone));

        if (shouldToolBackfill) {
            const routed = fastRouteTools(prompt || "");
            if (routed.length) {
                let bundle: Record<string, any>;
                if (agentsUsed.size > 0 && pulseIntent && !pulseDone) {
                    // Model already ran tools (e.g. searchWeb under GROQ_TOOL_CALLING=1) — only add missing RPC pulse
                    // to avoid duplicate treasury payments for news/search.
                    bundle = { ...lastToolResultsByName };
                    const dMatch = sNormBack.match(/\b(?:last|past|recent)\s+(\d{1,2})\s+blocks?\b/);
                    const depth = dMatch ? Math.min(20, Math.max(1, parseInt(dMatch[1], 10))) : 5;
                    const pulseSig = String(depth);
                    const pulseCall: RoutedToolCall = {
                        key: `getChainPulse:${slugKeyPart(pulseSig)}`,
                        name: "getChainPulse",
                        args: { depth },
                    };
                    const r = await executeToolCall(pulseCall);
                    bundle[r.key] = wrapToolResult(r.raw);
                } else {
                    bundle = {};
                    await Promise.all(
                        routed.map(async (c) => {
                            const r = await executeToolCall(c);
                            bundle[r.key] = wrapToolResult(r.raw);
                        })
                    );
                }
                const rendered = renderFastFromTools(bundle);
                const composed = (await composeFastToolAnswer(prompt || "", routed, bundle)).trim();
                const out = composed || (rendered ? rendered.trim() : "");
                if (out) {
                    const usedAgents = Array.from(agentsUsed);
                    if (usedAgents.length >= 2) {
                        const primaryAgent = pickPrimaryAgent(usedAgents);
                        const subAgents = usedAgents.filter((a) => a !== primaryAgent);
                        const a2aPromises = subAgents.map((subAgent) =>
                            sendAgentToAgentPayment(primaryAgent, subAgent, `coord:${subAgent}`).catch(() => undefined)
                        );
                        await Promise.race([Promise.all(a2aPromises), new Promise<void>((r) => setTimeout(r, 8000))]);
                    }
                    return {
                        response: sanitizeAssistantText(stripInlineRagCitations(out)),
                        agentsUsed: Array.from(agentsUsed),
                        txHashes,
                        a2aPayments: currentA2APayments,
                        partial,
                        ragSources,
                    };
                }
            }
        }

        return {
            response: responseOut,
            agentsUsed: Array.from(agentsUsed),
            txHashes,
            a2aPayments: currentA2APayments,
            partial: clientPartial,
            ragSources,
            webSources: collectWebSources(lastToolResultsByName),
        };
    } catch (error: any) {
        console.error(`[Gemini] ⚠️ Error generating response:`, error?.message);

        // Permanent mitigation: Groq tool-calling sometimes fails with HTTP 400 tool_use_failed.
        // If that happens, fall back to deterministic tool routing (fastRouteTools) and templated rendering.
        const msg = String(error?.message || "");
        if (msg.includes("tool_use_failed") || msg.includes("Failed to call a function")) {
            try {
                const routed = fastRouteTools(prompt || "");
                if (routed.length) {
                    const lastToolResultsByName: Record<string, any> = {};
                    await Promise.all(
                        routed.map(async (c) => {
                            const r = await executeToolCall(c);
                            lastToolResultsByName[r.key] = wrapToolResult(r.raw);
                        })
                    );
                    const rendered = renderFastFromTools(lastToolResultsByName);
                    if (rendered) {
                        const responseTextOut = (
                            await composeFastToolAnswer(prompt || "", routed, lastToolResultsByName)
                        ).trim();
                        return {
                            response: sanitizeAssistantText(stripInlineRagCitations(responseTextOut)),
                            agentsUsed: Array.from(agentsUsed),
                            txHashes,
                            a2aPayments: currentA2APayments,
                            partial: false,
                            ragSources,
                            webSources: collectWebSources(lastToolResultsByName),
                        };
                    }
                }
            } catch {}
        }
        
        if (error?.message?.includes("503") || error?.message?.includes("504")) {
            return {
                response: "Kairos is currently experiencing high demand. Please try again in a few moments! ⚡️",
                agentsUsed: [],
                txHashes: {},
                ragSources,
            };
        }
        
        if (error?.message?.includes("429")) {
            return {
                response: "Kairos is receiving too many requests. Please wait about 30 seconds for the quota to reset! ⏳",
                agentsUsed: [],
                txHashes: {},
                ragSources,
            };
        }

        throw error;
    }
}

export async function estimateTokens(text: string): Promise<number> {
    return Math.ceil(text.length / 4);
}

export async function calculateCost(
    inputTokens: number,
    outputTokens: number
): Promise<number> {
    const inputCost = (inputTokens / 1_000_000) * 0.5;
    const outputCost = (outputTokens / 1_000_000) * 3.0;
    return inputCost + outputCost;
}

