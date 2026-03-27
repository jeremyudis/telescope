import type { TelescopeAgent } from "./src/agent";

declare global {
  interface Env {
    AI: Ai;
    TELESCOPE_AGENT: DurableObjectNamespace<TelescopeAgent>;
    GITHUB_TOKEN: string;
    MODEL_PROVIDER?: string;
    ANTHROPIC_API_KEY?: string;
  }
}

export {};
