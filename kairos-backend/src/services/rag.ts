/**
 * Lightweight RAG:
 * Previously used Gemini embeddings. After migrating to Groq, we avoid embedding APIs
 * entirely and use deterministic keyword retrieval (BM25-like) over the same corpus.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { collectRemoteSourceUrls, fetchUrlAsPlainText } from "./rag-fetch.js";

export interface RagSource {
    source: string;
    score: number;
    excerpt: string;
    /** Original HTTPS URL when this chunk came from a live fetch */
    url?: string;
}

export interface RagAugmentation {
    prefixText: string;
    sources: RagSource[];
}

type IndexedChunk = {
    source: string;
    text: string;
    url?: string;
    tokens: string[];
};

const DEFAULT_CORPUS_DIR = "rag-corpus";

function isRagDisabled(): boolean {
    const v = (process.env.KAIROS_RAG || "1").trim().toLowerCase();
    return v === "0" || v === "false" || v === "off";
}

function tokenize(text: string): string[] {
    return (text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2 && t.length <= 32);
}

type RagIndex = {
    chunks: IndexedChunk[];
    df: Map<string, number>;
    avgdl: number;
};

function buildDf(chunks: IndexedChunk[]): { df: Map<string, number>; avgdl: number } {
    const df = new Map<string, number>();
    let totalLen = 0;
    for (const c of chunks) {
        totalLen += c.tokens.length;
        const seen = new Set(c.tokens);
        for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const avgdl = chunks.length ? totalLen / chunks.length : 0;
    return { df, avgdl };
}

function bm25Score(qTokens: string[], c: IndexedChunk, df: Map<string, number>, avgdl: number, N: number): number {
    const k1 = 1.2;
    const b = 0.75;
    if (!qTokens.length) return 0;
    const dl = c.tokens.length || 1;
    const tf = new Map<string, number>();
    for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of qTokens) {
        const f = tf.get(t) || 0;
        if (!f) continue;
        const dfi = df.get(t) || 0;
        const idf = Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5));
        const denom = f + k1 * (1 - b + b * (dl / (avgdl || 1)));
        score += idf * ((f * (k1 + 1)) / denom);
    }
    return score;
}

/** One retrieval slot per canonical page/file — avoids duplicate "open" links for the same page. */
function sourceDedupeKey(c: IndexedChunk): string {
    if (c.url) {
        try {
            const u = new URL(c.url);
            u.hash = "";
            u.search = "";
            const path = (u.pathname || "/").replace(/\/$/, "") || "/";
            return `url:${u.hostname.toLowerCase()}${path}`;
        } catch {
            return `url:${c.url}`;
        }
    }
    return `file:${c.source}`;
}

/**
 * When strict (default), only run RAG for questions about Kairos / deployment / docs —
 * not for generic market questions (avoids the same web docs surfacing every time).
 * Set KAIROS_RAG_STRICT=0 to always attempt vector retrieval.
 */
function ragIntentMatchesUserQuery(q: string): boolean {
    if ((process.env.KAIROS_RAG_STRICT || "1").trim() === "0") return true;
    const s = q.toLowerCase();
    const checks: RegExp[] = [
        /\bkairos\b/,
        /\bfour\.?meme\b/,
        /\bfourmeme\b/,
        /\bagent\s+registry\b/,
        /\bAGENT_REGISTRY\b/i,
        /\bspending\s+policy\b/,
        /\b(chain\s*id|chainid)\b/,
        /\bwhat\s+chain\b|\bwhich\s+chain\b/,
        /\bdeployed\s+on\b|\bdeployment\b/,
        /\b(contract|registry)\s+address\b/,
        /\b(railway|docker)\b.*\bkairos\b|\bkairos\b.*\b(railway|docker)\b/,
        /\bdeploy(ing|ment)?\b.*\bkairos\b/,
        /\bkairos\b.*\b(deploy|backend|env|environment)\b/,
        /\bmicropayment\b/,
        /\btreasury\b.*\b(pay|payment|agent)\b/,
        /\bpay(ing)?\s+agents?\b/,
        /\bgroq\s+api\s+key\b/,
        /\bhow\s+(does|do)\s+kairos\b/,
        /\bwhat\s+is\s+kairos\b/,
        /\bkairos\s+documentation\b/,
    ];
    return checks.some((re) => re.test(s));
}

function chunkMarkdown(text: string, maxLen = 900, minLen = 48): string[] {
    const parts = text.split(/\n{2,}/);
    const chunks: string[] = [];
    let buf = "";
    const pushBuf = () => {
        const t = buf.trim();
        if (t.length >= minLen) chunks.push(t);
        buf = "";
    };

    for (const p of parts) {
        const para = p.trim();
        if (!para) continue;
        if (para.length > maxLen) {
            pushBuf();
            for (let i = 0; i < para.length; i += maxLen - 100) {
                const slice = para.slice(i, i + maxLen).trim();
                if (slice.length >= minLen) chunks.push(slice);
            }
            continue;
        }
        if (buf.length + para.length + 2 <= maxLen) {
            buf = buf ? `${buf}\n\n${para}` : para;
        } else {
            pushBuf();
            buf = para;
        }
    }
    pushBuf();
    return chunks;
}

let indexPromise: Promise<RagIndex | null> | null = null;

async function listCorpusFiles(): Promise<string[]> {
    const extra = (process.env.KAIROS_RAG_FILES || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    const roots = new Set<string>();
    const cwd = process.cwd();
    roots.add(path.join(cwd, process.env.KAIROS_RAG_DIR?.trim() || DEFAULT_CORPUS_DIR));

    const files: string[] = [];
    for (const dir of roots) {
        try {
            const names = await readdir(dir);
            for (const n of names) {
                if (n.endsWith(".md")) files.push(path.join(dir, n));
            }
        } catch {
            // missing dir is OK
        }
    }
    for (const rel of extra) {
        const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
        files.push(abs);
    }
    return [...new Set(files)];
}

async function loadChunksFromDisk(): Promise<Array<{ source: string; text: string; url?: string }>> {
    const paths = await listCorpusFiles();
    const out: Array<{ source: string; text: string; url?: string }> = [];
    for (const fp of paths) {
        try {
            const raw = await readFile(fp, "utf8");
            const base = path.basename(fp);
            // Skip URL list files — handled by loadChunksFromRemote
            if (base === "sources.urls") continue;
            for (const text of chunkMarkdown(raw)) {
                out.push({ source: base, text });
            }
        } catch {
            console.warn(`[RAG] skip unreadable corpus file: ${fp}`);
        }
    }
    return out;
}

async function loadChunksFromRemote(): Promise<Array<{ source: string; text: string; url?: string }>> {
    const urls = await collectRemoteSourceUrls(process.cwd());
    if (urls.length === 0) return [];

    const out: Array<{ source: string; text: string; url?: string }> = [];
    let ok = 0;
    for (const u of urls) {
        const meta = await fetchUrlAsPlainText(u);
        if (!meta) continue;
        ok++;
        for (const text of chunkMarkdown(meta.text)) {
            out.push({ source: `web · ${meta.label}`, text, url: meta.url });
        }
        // Be polite to origin servers when indexing many URLs
        await new Promise((r) => setTimeout(r, Number(process.env.KAIROS_RAG_FETCH_GAP_MS || 250)));
    }
    console.log(`[RAG] remote: ${ok}/${urls.length} URLs OK → ${out.length} chunks`);
    return out;
}

async function buildIndex(): Promise<RagIndex | null> {
    const [localPieces, remotePieces] = await Promise.all([loadChunksFromDisk(), loadChunksFromRemote()]);
    const pieces = [...localPieces, ...remotePieces];
    if (pieces.length === 0) {
        console.warn(
            "[RAG] no corpus chunks (add .md under rag-corpus/, set KAIROS_RAG_URLS / sources.urls, or KAIROS_RAG_FILES)"
        );
        return null;
    }

    const chunks: IndexedChunk[] = pieces.map((p) => ({
        source: p.source,
        text: p.text,
        url: p.url,
        tokens: tokenize(p.text),
    }));

    const { df, avgdl } = buildDf(chunks);
    console.log(
        `[RAG] indexed ${chunks.length} chunks (${localPieces.length} local + ${remotePieces.length} remote text splits)`
    );
    return { chunks, df, avgdl };
}

function ensureIndex(): Promise<RagIndex | null> {
    if (!indexPromise) {
        indexPromise = buildIndex().catch((e) => {
            console.error("[RAG] index build failed:", e);
            return null;
        });
    }
    return indexPromise;
}

/**
 * Build / wait for the embedding index in the background so the first chat query
 * does not pay cold-start latency inside the per-request RAG budget.
 */
export function warmRagIndex(): void {
    if (isRagDisabled()) return;
    void ensureIndex()
        .then((idx) => {
            if (idx?.chunks?.length) console.log(`[RAG] corpus index ready (${idx.chunks.length} chunks)`);
        })
        .catch(() => undefined);
}

/**
 * Returns a prefix block for the current user turn and structured sources for the API/UI.
 * Null means RAG was skipped or nothing relevant was found.
 */
export async function retrieveRagAugmentation(userPrompt: string): Promise<RagAugmentation | null> {
    if (isRagDisabled()) return null;

    const trimmed = (userPrompt || "").trim();
    if (trimmed.length < 8) return null;

    if (!ragIntentMatchesUserQuery(trimmed)) {
        return null;
    }

    const index = await ensureIndex();
    if (!index || index.chunks.length === 0) return null;

    const budgetMs = Math.max(400, Number(process.env.KAIROS_RAG_BUDGET_MS || 2200));

    const retrieveOnly = async (): Promise<RagAugmentation | null> => {
        const qTokens = tokenize(trimmed);
        if (qTokens.length === 0) return null;

        const minScore = Number(process.env.KAIROS_RAG_MIN_SCORE || 0.35);
        const poolLimit = Math.max(8, Math.min(100, Number(process.env.KAIROS_RAG_TOP_K || 24)));
        const maxInPrompt = Math.max(1, Math.min(5, Number(process.env.KAIROS_RAG_MAX_CHUNKS || 3)));

        const productKairosQuestion =
            /\b(what|who)\s+(is|'s)\s+kairos\b|\bexplain\s+kairos\b|\bkairos\s+buddy\b|\babout\s+kairos\b|\btell\s+me\s+about\s+kairos\b/i.test(
                trimmed
            );

        const ranked = index.chunks
            .map((c) => {
                let score = bm25Score(qTokens, c, index.df, index.avgdl, index.chunks.length);
                // Hard-boost Kairos internal knowledge for product questions
                if (productKairosQuestion && c.source.includes("kairos-knowledge.md")) score += 2.5;
                return { c, score };
            })
            .filter((x) => x.score >= minScore)
            .sort((a, b) => b.score - a.score);

        if (ranked.length === 0) return null;

        // Scan a pool of top matches, then keep the best chunk per canonical URL/file so citations are not duplicated.
        const pool = ranked.slice(0, Math.min(poolLimit, ranked.length));

        const bestPerKey = new Map<string, { c: IndexedChunk; score: number }>();
        for (const x of pool) {
            const key = sourceDedupeKey(x.c);
            const prev = bestPerKey.get(key);
            if (!prev || x.score > prev.score) bestPerKey.set(key, x);
        }

        let diverse = [...bestPerKey.values()].sort((a, b) => b.score - a.score);

        // “What is Kairos?”-style questions are about the product.
        if (productKairosQuestion) {
            const peripheral = (x: { c: IndexedChunk }) => {
                const u = x.c.url || "";
                return (
                    u.includes("arxiv.org") ||
                    (u.includes("ai.google.dev") && u.includes("embeddings"))
                );
            };
            // For product questions, prefer Kairos local corpus over generic blockchain docs.
            // This prevents irrelevant developer docs from dominating retrieval for "what is kairos".
            const isRemoteWeb = (x: { c: IndexedChunk }) => (x.c.source || "").toLowerCase().startsWith("web ·");
            const isKairosLocal = (x: { c: IndexedChunk }) => {
                const src = (x.c.source || "").toLowerCase();
                return (
                    src.includes("kairos-knowledge.md") ||
                    src.includes("agent-payments.md") ||
                    // legacy filename; kept for compatibility if older corpus exists
                    src.includes("fourmeme-defi.md") ||
                    src.includes("crypto-defi-glossary.md")
                );
            };

            const noPeripheral = diverse.filter((x) => !peripheral(x));
            const localKairos = noPeripheral.filter((x) => !isRemoteWeb(x) && isKairosLocal(x));
            if (localKairos.length > 0) {
                diverse = localKairos;
            } else {
                const localOnly = noPeripheral.filter((x) => !isRemoteWeb(x));
                if (localOnly.length > 0) diverse = localOnly;
                else diverse = noPeripheral;
            }
        }

        const picked = diverse.slice(0, maxInPrompt);
        const lines: string[] = [
            "### Retrieved knowledge (internal)",
            "Use the excerpts below. Each **[Source N]** is a **different page or file** (same URL is not repeated). Cite with **[Source N]** when you use them. Live market data still requires your tools.",
            "",
        ];

        const sources: RagSource[] = [];
        picked.forEach((x, i) => {
            const n = i + 1;
            const linkLine = x.c.url ? `\nCanonical URL: ${x.c.url}` : "";
            lines.push(`**[Source ${n}]** (${x.c.source})${linkLine}`);
            lines.push(x.c.text);
            lines.push("");
            const excerpt = x.c.text.length > 220 ? `${x.c.text.slice(0, 217)}…` : x.c.text;
            sources.push({
                source: x.c.source,
                score: Math.round(x.score * 1000) / 1000,
                excerpt,
                url: x.c.url,
            });
        });

        return { prefixText: lines.join("\n"), sources };
    };

    const raced = await Promise.race([
        retrieveOnly()
            .then((r) => ({ kind: "done" as const, r }))
            .catch((e) => {
                console.error("[RAG] retrieve failed:", e);
                return { kind: "done" as const, r: null };
            }),
        new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), budgetMs)),
    ]);

    if (raced.kind === "timeout") {
        console.warn(`[RAG] query embed/score timed out after ${budgetMs}ms`);
        return null;
    }

    return raced.r;
}
