import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { TRIAGE_SYSTEM_PROMPT } from "./prompts";
import type { FileChange, TriageResult } from "./types";

const BATCH_SIZE = 5;
// Max chars of diff to send per file for triage (keep prompts small for fast model)
const MAX_DIFF_CHARS = 3000;

export async function triageFiles(
  files: FileChange[],
  triageModel: LanguageModel
): Promise<TriageResult[]> {
  const triageable = files.filter((f) => f.patch.length > 0);

  const results: TriageResult[] = [];

  for (let i = 0; i < triageable.length; i += BATCH_SIZE) {
    const batch = triageable.slice(i, i + BATCH_SIZE);
    console.log(
      `[triage] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(triageable.length / BATCH_SIZE)}: ${batch.map((f) => f.filename).join(", ")}`
    );
    const batchResults = await Promise.all(
      batch.map((file) => triageFile(file, triageModel))
    );
    results.push(...batchResults);
  }

  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results;
}

async function triageFile(
  file: FileChange,
  model: LanguageModel
): Promise<TriageResult> {
  try {
    // Truncate large diffs to keep triage fast
    const diff =
      file.patch.length > MAX_DIFF_CHARS
        ? file.patch.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)"
        : file.patch;

    const { text } = await generateText({
      model,
      system:
        TRIAGE_SYSTEM_PROMPT +
        `\n\nRespond with ONLY a JSON object in this exact format, no other text:\n{"relevant": true, "score": 7, "summary": "Brief summary"}`,
      prompt: `File: ${file.filename} (${file.language}, ${file.status}, +${file.additions}/-${file.deletions})\n\nDiff:\n${diff}`,
    });

    const parsed = parseTriageResponse(text);
    console.log(
      `[triage] ${file.filename}: score=${parsed.score} relevant=${parsed.relevant}`
    );
    return {
      filename: file.filename,
      relevant: parsed.relevant,
      relevanceScore: parsed.score,
      summary: parsed.summary,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.error(`[triage] FAILED ${file.filename}: ${msg}`);
    return {
      filename: file.filename,
      relevant: true,
      relevanceScore: 5,
      summary: `Triage failed: ${msg}. Including for safety.`,
    };
  }
}

function parseTriageResponse(text: string): {
  relevant: boolean;
  score: number;
  summary: string;
} {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      relevant: true,
      score: 5,
      summary: "Could not parse triage response",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      relevant: Boolean(parsed.relevant ?? true),
      score: Math.min(10, Math.max(0, Number(parsed.score ?? 5))),
      summary: String(parsed.summary ?? "No summary"),
    };
  } catch {
    return {
      relevant: true,
      score: 5,
      summary: "Could not parse triage JSON",
    };
  }
}
