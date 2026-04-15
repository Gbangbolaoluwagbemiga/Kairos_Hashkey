/**
 * Web-style research for Kairos.
 *
 * Priority:
 * 1) Tavily (`TAVILY_API_KEY`) — built for LLM/RAG pipelines, returns snippets + optional answer.
 * 2) Brave Search (`BRAVE_SEARCH_API_KEY`) — real web index.
 * 3) Groq fallback — **not** live web; honest labeling in `liveWeb` + source title.
 */

import { groqChatComplete } from "./groq-client.js";

export interface SearchResult {
    query: string;
    answer: string;
    liveWeb: boolean;
    provider: "tavily" | "brave" | "groq";
    /** ISO time when this result was assembled (for “freshness” UI). */
    fetchedAt: string;
    results: Array<{
        title: string;
        url: string;
        content: string;
    }>;
}

async function tavilySearch(query: string): Promise<SearchResult | null> {
    const apiKey = (process.env.TAVILY_API_KEY || "").trim();
    if (!apiKey) return null;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 18_000);
    try {
        const resp = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                search_depth: (process.env.TAVILY_SEARCH_DEPTH || "basic").trim() || "basic",
                max_results: Math.min(10, Math.max(3, Number(process.env.TAVILY_MAX_RESULTS || 6) || 6)),
                include_answer: true,
            }),
            signal: controller.signal,
        });
        if (!resp.ok) {
            const txt = await resp.text().catch(() => "");
            console.warn("[Search] Tavily HTTP", resp.status, txt.slice(0, 200));
            return null;
        }
        const json = (await resp.json()) as any;
        const results = Array.isArray(json?.results)
            ? json.results.map((r: any) => ({
                  title: String(r?.title || "Result"),
                  url: String(r?.url || ""),
                  content: String(r?.content || r?.snippet || "").slice(0, 900),
              }))
            : [];

        const answer =
            typeof json?.answer === "string" && json.answer.trim()
                ? json.answer.trim()
                : results.length
                  ? results
                        .slice(0, 4)
                        .map((r: { title: string; content: string }) => `**${r.title}**: ${r.content}`.trim())
                        .join("\n\n")
                  : "";

        if (!answer && !results.length) return null;

        return {
            query,
            answer: answer || "Here are the top indexed snippets for your query (see sources).",
            liveWeb: true,
            provider: "tavily",
            fetchedAt: new Date().toISOString(),
            results,
        };
    } catch (e: any) {
        console.warn("[Search] Tavily failed:", e?.message || e);
        return null;
    } finally {
        clearTimeout(t);
    }
}

async function braveSearch(query: string): Promise<SearchResult | null> {
    const apiKey = (process.env.BRAVE_SEARCH_API_KEY || "").trim();
    if (!apiKey) return null;

    const count = Math.min(10, Math.max(3, Number(process.env.BRAVE_MAX_RESULTS || 8) || 8));
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 18_000);
    try {
        const resp = await fetch(url.toString(), {
            method: "GET",
            headers: {
                Accept: "application/json",
                "X-Subscription-Token": apiKey,
            },
            signal: controller.signal,
        });
        if (!resp.ok) {
            const txt = await resp.text().catch(() => "");
            console.warn("[Search] Brave HTTP", resp.status, txt.slice(0, 200));
            return null;
        }
        const json = (await resp.json()) as any;
        const raw = Array.isArray(json?.web?.results) ? json.web.results : [];
        const results = raw.map((r: any) => ({
            title: String(r?.title || "Result"),
            url: String(r?.url || ""),
            content: String(r?.description || "").slice(0, 900),
        }));

        if (!results.length) return null;

        const answer = results
            .slice(0, 4)
            .map((r: { title: string; content: string; url: string }) => {
                const link = r.url ? ` (${r.url})` : "";
                return `**${r.title}**${link}\n${r.content}`.trim();
            })
            .join("\n\n");

        return {
            query,
            answer,
            liveWeb: true,
            provider: "brave",
            fetchedAt: new Date().toISOString(),
            results,
        };
    } catch (e: any) {
        console.warn("[Search] Brave failed:", e?.message || e);
        return null;
    } finally {
        clearTimeout(t);
    }
}

async function groqBestEffort(query: string): Promise<SearchResult> {
    const completion = await groqChatComplete({
        messages: [
            {
                role: "system",
                content:
                    "You are a careful crypto/DeFi research assistant. You do NOT have live web browsing in this mode. " +
                    "Answer succinctly, label uncertainty, and do not invent specific recent headlines, dates, or numbers. " +
                    "Suggest what the user should verify on-chain or on official dashboards when relevant.",
            },
            { role: "user", content: query },
        ],
        tools: undefined,
        toolChoice: "none",
        temperature: 0.2,
        maxTokens: 700,
        timeoutMs: 15000,
    });

    const text = (completion.content || "").trim();
    const results: SearchResult["results"] = [];
    if (text) {
        results.push({
            title: "Offline model summary (configure TAVILY_API_KEY or BRAVE_SEARCH_API_KEY for live web index)",
            url: "",
            content: text.slice(0, 400),
        });
    }

    return {
        query,
        answer: text || "I don’t have a live web index configured for this deployment, so I can’t verify fresh sources for that question.",
        liveWeb: false,
        provider: "groq",
        fetchedAt: new Date().toISOString(),
        results,
    };
}

/**
 * Best-effort research: real web index when API keys are set; otherwise honest Groq fallback.
 */
export async function searchWeb(query: string): Promise<SearchResult> {
    const q = (query || "").trim();
    if (!q) {
        return {
            query: q,
            answer: "Please provide a non-empty question.",
            liveWeb: false,
            provider: "groq",
            fetchedAt: new Date().toISOString(),
            results: [],
        };
    }

    const prefer = (process.env.KAIROS_WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();

    const tryOrder =
        prefer === "brave"
            ? ([braveSearch, tavilySearch] as const)
            : prefer === "tavily"
              ? ([tavilySearch, braveSearch] as const)
              : ([tavilySearch, braveSearch] as const);

    for (const fn of tryOrder) {
        try {
            const hit = await fn(q);
            if (hit) return hit;
        } catch (e: any) {
            console.warn("[Search] provider error:", e?.message || e);
        }
    }

    try {
        return await groqBestEffort(q);
    } catch (error: any) {
        console.error("[Search] Groq fallback error:", error.message ?? error);
        return {
            query: q,
            answer: "Search is temporarily unavailable. Please try again in a moment.",
            liveWeb: false,
            provider: "groq",
            fetchedAt: new Date().toISOString(),
            results: [],
        };
    }
}

let webSearchConfigLogged = false;

/** One-time startup hint: set Tavily or Brave in production for live web index. */
export function logWebSearchConfigOnce(): void {
    if (webSearchConfigLogged) return;
    webSearchConfigLogged = true;
    const tavily = !!(process.env.TAVILY_API_KEY || "").trim();
    const brave = !!(process.env.BRAVE_SEARCH_API_KEY || "").trim();
    const prefer = (process.env.KAIROS_WEB_SEARCH_PROVIDER || "auto").trim().toLowerCase();
    if (tavily || brave) {
        console.log(
            `[Search] Live web index: ${tavily ? "Tavily ✓" : "Tavily —"} ${brave ? "Brave ✓" : "Brave —"} (provider preference: ${prefer})`
        );
    } else {
        console.warn(
            "[Search] No TAVILY_API_KEY or BRAVE_SEARCH_API_KEY — searchWeb uses offline Groq summary. Set a key in production for fresh “what happened today” answers."
        );
    }
}
