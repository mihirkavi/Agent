import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function readCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000",
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime",
  taskModel: process.env.OPENAI_TASK_MODEL ?? "gpt-5.4-pro",
  fastModel: process.env.OPENAI_FAST_MODEL ?? "gpt-5.4",
  browserHeadless: process.env.BROWSER_HEADLESS !== "false",
  disableBrowserAutomation: process.env.DISABLE_BROWSER_AUTOMATION === "true",
  allowedAutomationDomains: new Set(readCsv(process.env.ALLOWED_AUTOMATION_DOMAINS)),
  dataDir: path.resolve(process.cwd(), ".data"),
  artifactDir: path.resolve(process.cwd(), ".data", "artifacts"),
  taskStorePath: path.resolve(process.cwd(), ".data", "tasks.json")
};

export function hasOpenAIKey(): boolean {
  return Boolean(config.openAiApiKey);
}
