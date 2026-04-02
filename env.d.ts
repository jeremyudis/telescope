import type { TelescopeAgent } from "./src/agent";
import type { IndexingJob } from "./src/types";

declare global {
  interface Env {
    AI: Ai;
    TELESCOPE_AGENT: DurableObjectNamespace<TelescopeAgent>;
    TELESCOPE_DB: D1Database;
    CODE_EMBEDDINGS: VectorizeIndex;
    INDEXING_QUEUE: Queue<IndexingJob>;
    GITHUB_TOKEN: string;
    MODEL_PROVIDER?: string;
    ANTHROPIC_API_KEY?: string;
  }
}

export {};
