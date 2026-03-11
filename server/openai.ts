import OpenAI from "openai";
import { config } from "./config.js";

let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!config.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  client ??= new OpenAI({
    apiKey: config.openAiApiKey
  });

  return client;
}
