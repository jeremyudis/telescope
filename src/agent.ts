import { Agent, callable } from "agents";
import { getModel } from "./model";
import { triageFiles } from "./triage";
import { analyzePR, formatReviewComment } from "./analysis";
import {
  fetchPRMetadata,
  fetchPRFiles,
  fetchDependencyManifests,
  fetchDefaultBranch,
  postReviewComment,
} from "./github";
import { indexRepository } from "./indexer";
import { querySimilarPatterns } from "./indexer";
import {
  getRepoProfile,
  getTelemetryInventory,
  getRecommendationPatterns,
  incrementReviewCount,
} from "./repo-profile";
import { recordRecommendations } from "./feedback";
import type { ReviewRequest, ReviewResult, IndexResult, IndexingJob } from "./types";

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
  async indexRepo(request: {
    owner: string;
    repo: string;
    ref?: string;
  }): Promise<IndexResult> {
    const { owner, repo, ref } = request;
    console.log(`[telescope] Indexing ${owner}/${repo}...`);

    // Check if we have an existing index for incremental update
    const profile = await getRepoProfile(owner, repo, this.env);

    if (profile?.lastIndexedSha && ref) {
      // Incremental update
      const { updateIndex } = await import("./indexer");
      return updateIndex(
        owner,
        repo,
        profile.lastIndexedSha,
        ref,
        this.env.GITHUB_TOKEN,
        this.env
      );
    }

    // Full index
    return indexRepository(
      owner,
      repo,
      ref ?? null,
      this.env.GITHUB_TOKEN,
      this.env
    );
  }

  @callable()
  async reviewPR(request: ReviewRequest): Promise<ReviewResult> {
    const { owner, repo, pullNumber } = request;
    const token = this.env.GITHUB_TOKEN;

    console.log(`[telescope] Starting review of ${owner}/${repo}#${pullNumber}`);

    // Fetch PR metadata, files, and repo profile in parallel
    const [prMeta, files, repoProfile] = await Promise.all([
      fetchPRMetadata(owner, repo, pullNumber, token),
      fetchPRFiles(owner, repo, pullNumber, token),
      getRepoProfile(owner, repo, this.env),
    ]);
    console.log(`[telescope] Fetched ${files.length} files, PR: "${prMeta.title}"`);

    // If repo not indexed, queue an indexing job (non-blocking)
    if (!repoProfile?.lastIndexedSha) {
      console.log(`[telescope] Repo not indexed, queuing initial index`);
      try {
        await this.env.INDEXING_QUEUE.send({
          owner,
          repo,
          ref: prMeta.headSha,
          mode: "full",
        } satisfies IndexingJob);
      } catch (err) {
        console.warn(`[telescope] Failed to queue indexing job: ${err}`);
      }
    }

    // Fetch dependency manifests (needs headSha from metadata)
    const manifests = await fetchDependencyManifests(
      owner,
      repo,
      prMeta.headSha,
      token
    );
    console.log(`[telescope] Found ${manifests.length} dependency manifests: ${manifests.map((m) => m.path).join(", ") || "none"}`);

    // Run triage and D1 queries in parallel (D1 queries don't depend on triage)
    console.log(`[telescope] Stage 1: Triaging ${files.length} files...`);
    const triageModel = getModel(this.env, "triage");

    const hasIndex = !!repoProfile?.lastIndexedSha;
    const hasSummary = !!repoProfile?.telemetrySummary;
    const [triageResults, inventory, patterns] = await Promise.all([
      triageFiles(files, triageModel),
      // Skip loading full inventory if we have a pre-generated summary
      hasIndex && !hasSummary ? getTelemetryInventory(owner, repo, this.env) : Promise.resolve([]),
      hasIndex ? getRecommendationPatterns(owner, repo, this.env) : Promise.resolve([]),
    ]);

    const relevant = triageResults.filter((t) => t.relevanceScore >= 7);
    console.log(`[telescope] Triage complete: ${relevant.length} high-relevance, ${triageResults.length} total`);

    // Now query for similar patterns using triage summaries (not filenames)
    let repoContext: {
      inventory: { filePath: string; segmentType: string; content: string }[];
      patterns: import("./types").RecommendationPatterns[];
      similarCode: { filePath: string; segmentType: string; content: string; context: string | null; score: number }[];
    } | null = null;

    if (hasIndex) {
      const semanticQuery = triageResults
        .filter((t) => t.relevanceScore >= 7)
        .slice(0, 5)
        .map((t) => `${t.filename}: ${t.summary}`)
        .join("\n");

      const similarCode = semanticQuery
        ? await querySimilarPatterns(semanticQuery, owner, repo, this.env)
        : [];

      repoContext = { inventory, patterns, similarCode };
      console.log(
        `[telescope] Repo context: ${inventory.length} inventory items, ${patterns.length} pattern categories, ${similarCode.length} similar matches`
      );
    }

    // Stage 2: Analysis
    console.log(`[telescope] Stage 2: Analyzing with full model...`);
    const analysisModel = getModel(this.env, "analysis");
    const { recommendations, summary } = await analyzePR(
      triageResults,
      files,
      manifests,
      prMeta,
      analysisModel,
      repoProfile,
      repoContext
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

    // Persist review
    this.setState({
      lastReview: result,
      reviewCount: this.state.reviewCount + 1,
    });

    this.sql`INSERT INTO reviews (owner, repo, pr_number, result, created_at)
             VALUES (${owner}, ${repo}, ${pullNumber}, ${JSON.stringify(result)}, ${result.timestamp})`;

    // Record recommendations for future feedback tracking
    try {
      await recordRecommendations(owner, repo, pullNumber, recommendations, this.env);
      await incrementReviewCount(owner, repo, this.env);
    } catch (err) {
      console.warn(`[telescope] Failed to record recommendations: ${err}`);
    }

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
