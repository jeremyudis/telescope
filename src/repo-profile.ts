import type { RepoProfile, RecommendationPatterns, RecommendationCategory } from "./types";

export async function getRepoProfile(
  owner: string,
  repo: string,
  env: Env
): Promise<RepoProfile | null> {
  const row = await env.TELESCOPE_DB.prepare(
    `SELECT * FROM repo_profiles WHERE owner = ? AND repo = ?`
  )
    .bind(owner, repo)
    .first<{
      owner: string;
      repo: string;
      last_indexed_at: string | null;
      last_indexed_sha: string | null;
      default_branch: string | null;
      primary_language: string | null;
      telemetry_stack: string | null;
      framework: string | null;
      total_reviews: number;
      telemetry_summary: string | null;
    }>();

  if (!row) return null;

  return {
    owner: row.owner,
    repo: row.repo,
    lastIndexedAt: row.last_indexed_at,
    lastIndexedSha: row.last_indexed_sha,
    defaultBranch: row.default_branch,
    primaryLanguage: row.primary_language,
    telemetryStack: row.telemetry_stack ? JSON.parse(row.telemetry_stack) : [],
    framework: row.framework,
    totalReviews: row.total_reviews,
    telemetrySummary: row.telemetry_summary,
  };
}

export async function getTelemetryInventory(
  owner: string,
  repo: string,
  env: Env
): Promise<{ filePath: string; segmentType: string; content: string }[]> {
  const result = await env.TELESCOPE_DB.prepare(
    `SELECT file_path, segment_type, content
     FROM telemetry_inventory
     WHERE owner = ? AND repo = ?
     ORDER BY segment_type, file_path`
  )
    .bind(owner, repo)
    .all<{ file_path: string; segment_type: string; content: string }>();

  return result.results.map((r) => ({
    filePath: r.file_path,
    segmentType: r.segment_type,
    content: r.content,
  }));
}

export async function getRecommendationPatterns(
  owner: string,
  repo: string,
  env: Env
): Promise<RecommendationPatterns[]> {
  const result = await env.TELESCOPE_DB.prepare(
    `SELECT
       category,
       COUNT(*) as total,
       SUM(CASE WHEN acted_on = 1 THEN 1 ELSE 0 END) as acted_on,
       SUM(CASE WHEN acted_on = 0 THEN 1 ELSE 0 END) as dismissed
     FROM recommendation_history
     WHERE owner = ? AND repo = ?
     GROUP BY category`
  )
    .bind(owner, repo)
    .all<{
      category: string;
      total: number;
      acted_on: number;
      dismissed: number;
    }>();

  return result.results.map((r) => ({
    category: r.category as RecommendationCategory,
    total: r.total,
    actedOn: r.acted_on,
    dismissed: r.dismissed,
    acceptanceRate: r.total > 0 ? r.acted_on / r.total : 0,
  }));
}

export async function incrementReviewCount(
  owner: string,
  repo: string,
  env: Env
): Promise<void> {
  await env.TELESCOPE_DB.prepare(
    `UPDATE repo_profiles SET total_reviews = total_reviews + 1 WHERE owner = ? AND repo = ?`
  )
    .bind(owner, repo)
    .run();
}
