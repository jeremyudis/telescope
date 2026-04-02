import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { analysisResultSchema } from "./schemas";
import { ANALYSIS_SYSTEM_PROMPT } from "./prompts";
import type {
  FileChange,
  TriageResult,
  DependencyManifest,
  PRMetadata,
  Recommendation,
  RecommendationPatterns,
  RepoProfile,
  ReviewResult,
} from "./types";

interface RepoContext {
  inventory: { filePath: string; segmentType: string; content: string }[];
  patterns: RecommendationPatterns[];
  similarCode: { filePath: string; segmentType: string; content: string; context: string | null; score: number }[];
}

const HIGH_RELEVANCE_THRESHOLD = 7;
const LOW_RELEVANCE_THRESHOLD = 3;
// Rough token budget for diff context (~4 chars per token)
const DIFF_CHAR_BUDGET = 80_000 * 4;

export async function analyzePR(
  triageResults: TriageResult[],
  files: FileChange[],
  dependencyManifests: DependencyManifest[],
  prMeta: PRMetadata,
  analysisModel: LanguageModel,
  repoProfile?: RepoProfile | null,
  repoContext?: RepoContext | null
): Promise<{
  recommendations: Recommendation[];
  summary: string;
}> {
  const userPrompt = buildAnalysisPrompt(
    triageResults,
    files,
    dependencyManifests,
    prMeta,
    repoProfile,
    repoContext
  );

  const { object } = await generateObject({
    model: analysisModel,
    system: ANALYSIS_SYSTEM_PROMPT,
    prompt: userPrompt,
    schema: analysisResultSchema,
  });

  return {
    recommendations: object.recommendations,
    summary: object.summary,
  };
}

function buildAnalysisPrompt(
  triageResults: TriageResult[],
  files: FileChange[],
  dependencyManifests: DependencyManifest[],
  prMeta: PRMetadata,
  repoProfile?: RepoProfile | null,
  repoContext?: RepoContext | null
): string {
  const sections: string[] = [];

  // PR metadata
  sections.push(
    `## Pull Request\n\n**Title**: ${prMeta.title}\n**Description**: ${prMeta.description || "(none)"}\n**Branch**: ${prMeta.headRef} → ${prMeta.baseRef}`
  );

  // Dependency manifests (raw, for the LLM to interpret)
  if (dependencyManifests.length > 0) {
    sections.push("## Project Dependencies\n");
    for (const manifest of dependencyManifests) {
      sections.push(`### ${manifest.path}\n\`\`\`\n${manifest.content}\n\`\`\``);
    }
  }

  // Separate high-relevance (include full diff) from medium (summary only)
  const highRelevance = triageResults.filter(
    (t) => t.relevanceScore >= HIGH_RELEVANCE_THRESHOLD
  );
  const mediumRelevance = triageResults.filter(
    (t) =>
      t.relevanceScore >= LOW_RELEVANCE_THRESHOLD &&
      t.relevanceScore < HIGH_RELEVANCE_THRESHOLD
  );

  // High-relevance files: include full diffs within budget
  if (highRelevance.length > 0) {
    sections.push("## High-Relevance Files (full diffs)\n");
    let charBudget = DIFF_CHAR_BUDGET;

    for (const triage of highRelevance) {
      const file = files.find((f) => f.filename === triage.filename);
      if (!file) continue;

      const header = `### ${file.filename} (${file.language}, ${file.status}, +${file.additions}/-${file.deletions})\n**Triage**: ${triage.summary}\n`;
      const diffBlock = `\`\`\`diff\n${file.patch}\n\`\`\`\n`;
      const entry = header + diffBlock;

      if (entry.length <= charBudget) {
        sections.push(entry);
        charBudget -= entry.length;
      } else {
        // Diff too large — include summary only
        sections.push(
          header + `*(diff truncated — ${file.patch.length} chars)*\n`
        );
      }
    }
  }

  // Medium-relevance files: summaries only
  if (mediumRelevance.length > 0) {
    sections.push("## Medium-Relevance Files (summaries)\n");
    for (const triage of mediumRelevance) {
      sections.push(
        `- **${triage.filename}** (score: ${triage.relevanceScore}): ${triage.summary}`
      );
    }
  }

  // Repository intelligence (if available)
  if (repoProfile) {
    // Pre-generated architecture summary (replaces raw inventory dump)
    if (repoProfile.telemetrySummary) {
      sections.push("## Repository Telemetry Architecture\n");
      sections.push(repoProfile.telemetrySummary);
    } else {
      // Fallback: basic profile info
      sections.push("## Repository Profile\n");
      sections.push(
        `- **Telemetry stack**: ${repoProfile.telemetryStack.length > 0 ? repoProfile.telemetryStack.join(", ") : "unknown"}`
      );
      if (repoProfile.framework) {
        sections.push(`- **Framework**: ${repoProfile.framework}`);
      }
      sections.push(`- **Total reviews**: ${repoProfile.totalReviews}`);
    }
  }

  if (repoContext) {
    // Similar patterns in this codebase (from semantic search)
    if (repoContext.similarCode.length > 0) {
      sections.push("## Similar Patterns in This Codebase\n");
      sections.push(
        "Existing telemetry code in this repo that is similar to the current PR's changes:\n"
      );
      for (const match of repoContext.similarCode) {
        const description = match.context
          ? `${match.context}`
          : `${match.segmentType} pattern`;
        sections.push(
          `- \`${match.filePath}\` (${description}, similarity: ${(match.score * 100).toFixed(0)}%):\n\`\`\`\n${match.content.slice(0, 400)}\n\`\`\``
        );
      }
    }

    // Recommendation acceptance patterns
    if (repoContext.patterns.length > 0) {
      sections.push("## Recommendation History\n");
      sections.push(
        "Past recommendation acceptance rates for this repo:\n"
      );
      for (const p of repoContext.patterns) {
        sections.push(
          `- **${p.category}**: ${(p.acceptanceRate * 100).toFixed(0)}% accepted (${p.actedOn}/${p.total} acted on, ${p.dismissed} dismissed)`
        );
      }
      sections.push(
        "\nUse this to prioritize recommendations that this repo's maintainers tend to act on."
      );
    }
  }

  // Stats
  const skipped = triageResults.filter(
    (t) => t.relevanceScore < LOW_RELEVANCE_THRESHOLD
  ).length;
  sections.push(
    `\n## Stats\n- High relevance: ${highRelevance.length} files\n- Medium relevance: ${mediumRelevance.length} files\n- Skipped (low relevance): ${skipped} files`
  );

  return sections.join("\n\n");
}

export function formatReviewComment(result: ReviewResult): string {
  const lines: string[] = [];

  lines.push("## Telescope — Observability Review\n");
  lines.push(`**Summary**: ${result.summary}\n`);
  lines.push(
    `**Files analyzed**: ${result.filesAnalyzed} | **Triaged**: ${result.filesTriaged} | **Skipped**: ${result.filesSkipped} | **Recommendations**: ${result.recommendations.length}\n`
  );

  const critical = result.recommendations.filter(
    (r) => r.severity === "critical"
  );
  const warnings = result.recommendations.filter(
    (r) => r.severity === "warning"
  );
  const info = result.recommendations.filter((r) => r.severity === "info");

  if (critical.length > 0) {
    lines.push(`### Critical (${critical.length})\n`);
    lines.push(formatRecommendationTable(critical));
  }

  if (warnings.length > 0) {
    lines.push(`### Warnings (${warnings.length})\n`);
    lines.push(formatRecommendationTable(warnings));
  }

  if (info.length > 0) {
    lines.push(`### Info (${info.length})\n`);
    lines.push(formatRecommendationTable(info));
  }

  if (result.recommendations.length === 0) {
    lines.push(
      "*No observability issues found. This PR looks good from a telemetry perspective.*"
    );
  }

  lines.push("\n---\n*Generated by [telescope](https://github.com/telescope)*");

  return lines.join("\n");
}

function formatRecommendationTable(recommendations: Recommendation[]): string {
  const lines: string[] = [];
  lines.push("| File | Category | Issue | Suggestion |");
  lines.push("|------|----------|-------|------------|");

  for (const rec of recommendations) {
    const location = rec.line
      ? `\`${rec.file}:${rec.line}\``
      : `\`${rec.file}\``;
    const suggestion = rec.suggestion
      ? rec.suggestion.replace(/\|/g, "\\|").replace(/\n/g, " ")
      : "—";
    const desc = rec.description.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(
      `| ${location} | ${rec.category} | **${rec.title}**: ${desc} | ${suggestion} |`
    );
  }

  return lines.join("\n");
}
