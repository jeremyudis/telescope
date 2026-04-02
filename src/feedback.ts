import type { Recommendation } from "./types";

export async function recordRecommendations(
  owner: string,
  repo: string,
  prNumber: number,
  recommendations: Recommendation[],
  env: Env
): Promise<void> {
  if (recommendations.length === 0) return;

  const stmt = env.TELESCOPE_DB.prepare(
    `INSERT INTO recommendation_history (owner, repo, pr_number, category, title, file_path, acted_on, feedback, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
  );

  const now = new Date().toISOString();
  const batch = recommendations.map((rec) =>
    stmt.bind(owner, repo, prNumber, rec.category, rec.title, rec.file, now)
  );

  for (let i = 0; i < batch.length; i += 100) {
    await env.TELESCOPE_DB.batch(batch.slice(i, i + 100));
  }
}

export async function recordFeedback(
  owner: string,
  repo: string,
  prNumber: number,
  recommendationId: number,
  feedback: "positive" | "negative",
  env: Env
): Promise<void> {
  await env.TELESCOPE_DB.prepare(
    `UPDATE recommendation_history
     SET feedback = ?
     WHERE id = ? AND owner = ? AND repo = ? AND pr_number = ?`
  )
    .bind(feedback, recommendationId, owner, repo, prNumber)
    .run();
}

export async function markRecommendationActedOn(
  owner: string,
  repo: string,
  prNumber: number,
  filePath: string,
  category: string,
  actedOn: boolean,
  env: Env
): Promise<void> {
  await env.TELESCOPE_DB.prepare(
    `UPDATE recommendation_history
     SET acted_on = ?
     WHERE owner = ? AND repo = ? AND pr_number = ? AND file_path = ? AND category = ?`
  )
    .bind(actedOn ? 1 : 0, owner, repo, prNumber, filePath, category)
    .run();
}

export async function checkRecommendationFollowUp(
  owner: string,
  repo: string,
  prNumber: number,
  changedFiles: string[],
  env: Env
): Promise<number> {
  if (changedFiles.length === 0) return 0;

  // Find pending recommendations for this PR
  const pending = await env.TELESCOPE_DB.prepare(
    `SELECT DISTINCT file_path, category FROM recommendation_history
     WHERE owner = ? AND repo = ? AND pr_number = ? AND acted_on IS NULL`
  )
    .bind(owner, repo, prNumber)
    .all<{ file_path: string; category: string }>();

  if (pending.results.length === 0) return 0;

  const changedSet = new Set(changedFiles);
  let actedCount = 0;

  for (const rec of pending.results) {
    if (changedSet.has(rec.file_path)) {
      await markRecommendationActedOn(
        owner, repo, prNumber, rec.file_path, rec.category, true, env
      );
      actedCount++;
    }
  }

  if (actedCount > 0) {
    console.log(
      `[feedback] ${actedCount} recommendations on ${owner}/${repo}#${prNumber} marked as acted on`
    );
  }

  return actedCount;
}
