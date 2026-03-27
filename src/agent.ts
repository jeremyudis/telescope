import { Agent, callable } from "agents";
import { getModel } from "./model";
import { triageFiles } from "./triage";
import { analyzePR, formatReviewComment } from "./analysis";
import {
  fetchPRMetadata,
  fetchPRFiles,
  fetchDependencyManifests,
  postReviewComment,
} from "./github";
import type { ReviewRequest, ReviewResult } from "./types";

interface TelescopeState {
  lastReview?: ReviewResult;
  reviewCount: number;
}

export class TelescopeAgent extends Agent<Env, TelescopeState> {
  initialState: TelescopeState = { reviewCount: 0 };

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`;
  }

  @callable()
  async reviewPR(request: ReviewRequest): Promise<ReviewResult> {
    const { owner, repo, pullNumber } = request;
    const token = this.env.GITHUB_TOKEN;

    console.log(`[telescope] Starting review of ${owner}/${repo}#${pullNumber}`);

    // Fetch PR metadata and files in parallel
    const [prMeta, files] = await Promise.all([
      fetchPRMetadata(owner, repo, pullNumber, token),
      fetchPRFiles(owner, repo, pullNumber, token),
    ]);
    console.log(`[telescope] Fetched ${files.length} files, PR: "${prMeta.title}"`);

    // Fetch dependency manifests (needs headSha from metadata)
    const manifests = await fetchDependencyManifests(
      owner,
      repo,
      prMeta.headSha,
      token
    );
    console.log(`[telescope] Found ${manifests.length} dependency manifests: ${manifests.map((m) => m.path).join(", ") || "none"}`);

    // Stage 1: Triage
    console.log(`[telescope] Stage 1: Triaging ${files.length} files...`);
    const triageModel = getModel(this.env, "triage");
    const triageResults = await triageFiles(files, triageModel);
    const relevant = triageResults.filter((t) => t.relevanceScore >= 7);
    console.log(`[telescope] Triage complete: ${relevant.length} high-relevance, ${triageResults.length} total`);

    // Stage 2: Analysis
    console.log(`[telescope] Stage 2: Analyzing with full model...`);
    const analysisModel = getModel(this.env, "analysis");
    const { recommendations, summary } = await analyzePR(
      triageResults,
      files,
      manifests,
      prMeta,
      analysisModel
    );
    console.log(`[telescope] Analysis complete: ${recommendations.length} recommendations`);

    const result: ReviewResult = {
      owner,
      repo,
      pullNumber,
      recommendations,
      summary,
      filesAnalyzed: relevant.length,
      filesTriaged: triageResults.length,
      filesSkipped: files.length - triageResults.length,
      timestamp: new Date().toISOString(),
    };

    // Persist
    this.setState({
      lastReview: result,
      reviewCount: this.state.reviewCount + 1,
    });

    this.sql`INSERT INTO reviews (owner, repo, pr_number, result, created_at)
             VALUES (${owner}, ${repo}, ${pullNumber}, ${JSON.stringify(result)}, ${result.timestamp})`;

    return result;
  }

  @callable()
  async reviewAndComment(request: ReviewRequest): Promise<ReviewResult> {
    const result = await this.reviewPR(request);

    const comment = formatReviewComment(result);
    await postReviewComment(
      result.owner,
      result.repo,
      result.pullNumber,
      this.env.GITHUB_TOKEN,
      comment
    );

    return result;
  }
}
