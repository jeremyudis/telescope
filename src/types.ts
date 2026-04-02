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

// --- Code Intelligence Types ---

export type SegmentType =
  | "metric_definition"
  | "span_creation"
  | "logger_setup"
  | "middleware"
  | "error_handler"
  | "config";

export interface CodeSegment {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  segmentType: SegmentType;
  language: string;
  content: string;
  context?: string;
}

export interface IndexResult {
  owner: string;
  repo: string;
  segmentsIndexed: number;
  filesProcessed: number;
  sha: string;
  timestamp: string;
}

export interface IndexingJob {
  owner: string;
  repo: string;
  ref: string;
  mode: "full" | "incremental";
  previousSha?: string;
}

export interface RepoProfile {
  owner: string;
  repo: string;
  lastIndexedAt: string | null;
  lastIndexedSha: string | null;
  defaultBranch: string | null;
  primaryLanguage: string | null;
  telemetryStack: string[];
  framework: string | null;
  totalReviews: number;
  telemetrySummary: string | null;
}

export interface RecommendationRecord {
  id: number;
  owner: string;
  repo: string;
  prNumber: number;
  category: RecommendationCategory;
  title: string;
  filePath: string;
  actedOn: boolean | null;
  feedback: "positive" | "negative" | null;
  createdAt: string;
}

export interface RecommendationPatterns {
  category: RecommendationCategory;
  total: number;
  actedOn: number;
  dismissed: number;
  acceptanceRate: number;
}
