/**
 * Load `.env` from the kairos-backend root regardless of `process.cwd()`
 * (e.g. monorepo / IDE runners). Must be imported before other backend modules
 * that read `process.env` (Brave/Tavily, Groq, on-chain config, etc.).
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, "..");
const envPath = path.join(backendRoot, ".env");

if (fs.existsSync(envPath)) {
    const r = dotenv.config({ path: envPath });
    if (r.error) {
        console.warn("[Env] Failed to load", envPath, r.error.message);
    }
} else {
    console.warn(`[Env] No file at ${envPath} — set env vars in the host or create kairos-backend/.env`);
}
