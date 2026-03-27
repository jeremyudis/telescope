import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";

type ModelTier = "triage" | "analysis";

const WORKERS_AI_MODELS: Record<ModelTier, string> = {
  triage: "@cf/meta/llama-3.2-3b-instruct",
  analysis: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
};

const ANTHROPIC_MODELS: Record<ModelTier, string> = {
  triage: "claude-haiku-4-5-20251001",
  analysis: "claude-sonnet-4-20250514",
};

export function getModel(env: Env, tier: ModelTier): LanguageModel {
  const provider = env.MODEL_PROVIDER ?? "workers-ai";

  if (provider === "anthropic") {
    return getAnthropicModel(env, tier);
  }

  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(WORKERS_AI_MODELS[tier]);
}

function getAnthropicModel(env: Env, tier: ModelTier): LanguageModel {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is required when MODEL_PROVIDER=anthropic"
    );
  }
  // To use Anthropic: npm install @ai-sdk/anthropic
  // Then set MODEL_PROVIDER=anthropic and ANTHROPIC_API_KEY as a secret
  //
  // Uncomment below and comment out the throw:
  // import { createAnthropic } from "@ai-sdk/anthropic";
  // const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  // return anthropic(ANTHROPIC_MODELS[tier]);

  throw new Error(
    "Anthropic provider is not configured. See src/model.ts for setup instructions."
  );
}
