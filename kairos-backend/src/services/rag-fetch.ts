/**
 * Fetch public HTTPS documents for RAG indexing (docs sites, arXiv pages, raw markdown on GitHub).
 * Guards against basic SSRF; only GET, size-capped.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.KAIROS_RAG_FETCH_TIMEOUT_MS || 20000));
const MAX_BYTES = Math.max(50_000, Math.min(5_000_000, Number(process.env.KAIROS_RAG_FETCH_MAX_BYTES || 2_000_000)));

export type RemoteChunkMeta = { label: string; text: string; url: string };

function isBlockedHostname(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
    if (h === "metadata.google.internal" || h.includes("metadata")) return true;
    // IPv4 literals
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    }
    return false;
}

/** Only https (http allowed only for localhost — not used by default). */
export function assertPublicHttpsUrl(raw: string): URL {
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        throw new Error("invalid URL");
    }
    if (u.protocol !== "https:") {
        throw new Error("only https URLs are allowed for RAG fetch");
    }
    if (isBlockedHostname(u.hostname)) {
        throw new Error("hostname not allowed");
    }
    return u;
}

function htmlToPlainText(html: string): string {
    let t = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
    t = t.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
    t = t.replace(/<\/(p|div|br|li|h[1-6]|tr)\s*>/gi, "\n");
    t = t.replace(/<[^>]+>/g, " ");
    t = t.replace(/&nbsp;/g, " ");
    t = t.replace(/&amp;/g, "&");
    t = t.replace(/&lt;/g, "<");
    t = t.replace(/&gt;/g, ">");
    t = t.replace(/&quot;/g, '"');
    t = t.replace(/\s*\n\s*/g, "\n");
    t = t.replace(/[ \t]+/g, " ");
    return t.trim();
}

function shortLabel(url: URL): string {
    const p = url.pathname.length > 42 ? `${url.pathname.slice(0, 40)}…` : url.pathname;
    return `${url.hostname}${p || ""}`;
}

/**
 * GET url and return plain text suitable for chunking.
 */
export async function fetchUrlAsPlainText(urlStr: string): Promise<RemoteChunkMeta | null> {
    const url = assertPublicHttpsUrl(urlStr);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url.toString(), {
            signal: ac.signal,
            redirect: "follow",
            headers: {
                "User-Agent": "Kairos-RAG/1.0 (documentation indexing; +https://github.com/)",
                Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
            },
        });
        if (!res.ok) {
            console.warn(`[RAG] fetch ${url.hostname} → HTTP ${res.status}`);
            return null;
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_BYTES) {
            console.warn(`[RAG] skip ${url.hostname}: body too large (${buf.byteLength} bytes)`);
            return null;
        }
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);

        let text: string;
        if (ct.includes("json") || url.pathname.endsWith(".json")) {
            try {
                text = JSON.stringify(JSON.parse(raw), null, 2);
            } catch {
                text = raw;
            }
        } else if (ct.includes("text/html") || raw.trimStart().startsWith("<!")) {
            text = htmlToPlainText(raw);
        } else {
            text = raw;
        }

        text = text.replace(/\u0000/g, "").trim();
        if (text.length < 80) {
            console.warn(`[RAG] skip ${url.hostname}: extracted text too short`);
            return null;
        }

        return { url: url.toString(), label: shortLabel(url), text };
    } catch (e: any) {
        console.warn(`[RAG] fetch failed ${urlStr}:`, e?.message || e);
        return null;
    } finally {
        clearTimeout(to);
    }
}

function parseUrlListFile(content: string): string[] {
    const out: string[] = [];
    for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        if (t.startsWith("https://")) out.push(t);
    }
    return out;
}

/** URLs from KAIROS_RAG_URLS (comma-separated) and optional rag-corpus/sources.urls */
export async function collectRemoteSourceUrls(cwd: string): Promise<string[]> {
    const fromEnv = (process.env.KAIROS_RAG_URLS || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("https://"));

    const filePath = path.join(cwd, process.env.KAIROS_RAG_DIR?.trim() || "rag-corpus", "sources.urls");
    let fromFile: string[] = [];
    try {
        const txt = await readFile(filePath, "utf8");
        fromFile = parseUrlListFile(txt);
    } catch {
        // optional file
    }

    return [...new Set([...fromEnv, ...fromFile])];
}
