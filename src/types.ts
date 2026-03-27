export interface ReviewRequest {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface FileChange {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
  language: string;
}

export interface DependencyManifest {
  path: string;
  content: string;
}

export interface TriageResult {
  filename: string;
  relevant: boolean;
  relevanceScore: number;
  summary: string;
}

export type RecommendationCategory =
  | "missing-telemetry"
  | "high-cardinality"
  | "instrumentation"
  | "logging"
  | "error-tracking"
  | "naming"
  | "best-practice";

export type Severity = "info" | "warning" | "critical";

export interface Recommendation {
  file: string;
  line?: number;
  category: RecommendationCategory;
  severity: Severity;
  title: string;
  description: string;
  suggestion?: string;
}

export interface ReviewResult {
  owner: string;
  repo: string;
  pullNumber: number;
  recommendations: Recommendation[];
  summary: string;
  filesAnalyzed: number;
  filesTriaged: number;
  filesSkipped: number;
  timestamp: string;
}

export interface PRMetadata {
  title: string;
  description: string;
  baseRef: string;
  headRef: string;
  headSha: string;
}
