import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function listModels() {
    console.log("This project has migrated from Gemini to Groq.");
    console.log("Set GROQ_MODEL in your environment to choose a model.");
    console.log("Default: llama-3.3-70b-versatile");
}

listModels().catch((err) => console.error(err.message));
