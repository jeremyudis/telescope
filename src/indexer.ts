import {
  fetchRepoTree,
  fetchCompare,
  fetchFileContent,
  fetchDefaultBranch,
} from "./github";
import {
  extractSegments,
  detectLanguage,
  shouldIndexFile,
} from "./segments";
import type { CodeSegment, IndexResult } from "./types";

const FILE_FETCH_BATCH_SIZE = 10;
const EMBEDDING_BATCH_SIZE = 20;
const ENRICHMENT_BATCH_SIZE = 8;

// Vectorize IDs have a 64-byte limit. Hash long identifiers.
async function vectorId(
  owner: string,
  repo: string,
  filePath: string,
  segmentType: string,
  lineStart: number
): Promise<string> {
  const raw = `${owner}/${repo}:${filePath}:${segmentType}:${lineStart}`;
  if (raw.length <= 64) return raw;
  // Use a short hash for long IDs
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const hashHex = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex.slice(0, 64);
}

async function enrichSegmentsWithLLM(
  segments: CodeSegment[],
  env: Env
): Promise<CodeSegment[]> {
  if (segments.length === 0) return segments;

  for (let i = 0; i < segments.length; i += ENRICHMENT_BATCH_SIZE) {
    const batch = segments.slice(i, i + ENRICHMENT_BATCH_SIZE);

    const segmentDescriptions = batch
      .map(
        (seg, idx) =>
          `${idx + 1}. [${seg.segmentType}] in ${seg.filePath} (lines ${seg.lineStart}-${seg.lineEnd}):\n\`\`\`\n${seg.content.slice(0, 400)}\n\`\`\``
      )
      .join("\n\n");

    const prompt = `For each code segment below, write a one-sentence description of what it does, what module/service it belongs to, and what telemetry pattern it follows.

Respond with ONLY a JSON array of strings, one per segment, in the same order. No markdown, no explanation.

Segments:
${segmentDescriptions}`;

    try {
      const response = await env.AI.run(
        "@cf/meta/llama-3.2-3b-instruct",
        { prompt }
      ) as { response?: string };

      const text = response.response ?? "";

      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const descriptions = JSON.parse(jsonMatch[0]) as string[];
        for (let j = 0; j < batch.length && j < descriptions.length; j++) {
          if (typeof descriptions[j] === "string" && descriptions[j].length > 10) {
            batch[j].context = descriptions[j];
          }
        }
      }
    } catch (err) {
      console.warn(`[indexer] LLM enrichment failed for batch ${i}: ${err}`);
    }

    // Fill in fallback for any segments that didn't get enriched
    for (const seg of batch) {
      if (!seg.context) {
        seg.context = `${seg.segmentType} in ${seg.filePath}:${seg.lineStart} (${seg.language})`;
      }
    }
  }

  return segments;
}

export async function indexRepository(
  owner: string,
  repo: string,
  ref: string | null,
  token: string,
  env: Env
): Promise<IndexResult> {
  // Resolve ref to a SHA if not provided
  let sha: string;
  let defaultBranch: string | null = null;

  if (ref) {
    sha = ref;
  } else {
    const info = await fetchDefaultBranch(owner, repo, token);
    sha = info.sha;
    defaultBranch = info.branch;
  }

  console.log(`[indexer] Full index of ${owner}/${repo} at ${sha}`);

  // Fetch the full file tree
  const tree = await fetchRepoTree(owner, repo, sha, token);

  // Filter to indexable files
  const indexableFiles = tree.filter((entry) => shouldIndexFile(entry.path));
  console.log(
    `[indexer] ${tree.length} total files, ${indexableFiles.length} indexable`
  );

  let totalSegments = 0;
  let filesProcessed = 0;

  // Process files in batches
  for (let i = 0; i < indexableFiles.length; i += FILE_FETCH_BATCH_SIZE) {
    const batch = indexableFiles.slice(i, i + FILE_FETCH_BATCH_SIZE);

    // Fetch file contents in parallel
    const contents = await Promise.all(
      batch.map(async (entry) => {
        const content = await fetchFileContent(
          owner,
          repo,
          entry.path,
          sha,
          token
        );
        return { path: entry.path, content };
      })
    );

    // Extract segments from each file
    const allSegments: CodeSegment[] = [];
    for (const { path, content } of contents) {
      if (!content) continue;
      filesProcessed++;
      const language = detectLanguage(path);
      const segments = extractSegments(path, content, language);
      allSegments.push(...segments);
    }

    if (allSegments.length > 0) {
      // Enrich segments with LLM-generated descriptions
      await enrichSegmentsWithLLM(allSegments, env);
      // Store segments in D1 and generate embeddings
      await storeSegments(owner, repo, allSegments, env);
      await generateAndStoreEmbeddings(owner, repo, allSegments, env);
      totalSegments += allSegments.length;
    }
  }

  // Detect telemetry stack from segments
  const stack = await detectTelemetryStack(owner, repo, env);

  // Update repo profile
  const timestamp = new Date().toISOString();
  await env.TELESCOPE_DB.prepare(
    `INSERT INTO repo_profiles (owner, repo, last_indexed_at, last_indexed_sha, default_branch, primary_language, telemetry_stack, framework, total_reviews)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
     ON CONFLICT (owner, repo) DO UPDATE SET
       last_indexed_at = excluded.last_indexed_at,
       last_indexed_sha = excluded.last_indexed_sha,
       default_branch = COALESCE(excluded.default_branch, repo_profiles.default_branch),
       telemetry_stack = excluded.telemetry_stack`
  )
    .bind(
      owner,
      repo,
      timestamp,
      sha,
      defaultBranch,
      null, // primary_language detected later
      JSON.stringify(stack)
    )
    .run();

  // Generate telemetry architecture summary
  await generateTelemetrySummary(owner, repo, env);

  console.log(
    `[indexer] Indexed ${totalSegments} segments from ${filesProcessed} files`
  );

  return {
    owner,
    repo,
    segmentsIndexed: totalSegments,
    filesProcessed,
    sha,
    timestamp,
  };
}

export async function updateIndex(
  owner: string,
  repo: string,
  oldSha: string,
  newSha: string,
  token: string,
  env: Env
): Promise<IndexResult> {
  if (oldSha === newSha) {
    console.log(`[indexer] ${owner}/${repo} already up to date at ${newSha}`);
    return {
      owner,
      repo,
      segmentsIndexed: 0,
      filesProcessed: 0,
      sha: newSha,
      timestamp: new Date().toISOString(),
    };
  }

  console.log(
    `[indexer] Incremental update of ${owner}/${repo}: ${oldSha.slice(0, 7)}..${newSha.slice(0, 7)}`
  );

  // Get changed files via compare API
  const changedFiles = await fetchCompare(owner, repo, oldSha, newSha, token);
  console.log(`[indexer] ${changedFiles.length} files changed`);

  if (changedFiles.length === 0) {
    const timestamp = new Date().toISOString();
    await env.TELESCOPE_DB.prepare(
      `UPDATE repo_profiles SET last_indexed_at = ?, last_indexed_sha = ? WHERE owner = ? AND repo = ?`
    )
      .bind(timestamp, newSha, owner, repo)
      .run();
    return {
      owner,
      repo,
      segmentsIndexed: 0,
      filesProcessed: 0,
      sha: newSha,
      timestamp,
    };
  }

  // Handle deleted files — remove their segments
  const deleted = changedFiles.filter((f) => f.status === "removed");
  for (const file of deleted) {
    await removeFileSegments(owner, repo, file.filename, env);
  }

  // Handle added/modified files — re-index them
  const toIndex = changedFiles
    .filter((f) => f.status !== "removed" && shouldIndexFile(f.filename))
    .map((f) => f.filename);

  let totalSegments = 0;

  for (let i = 0; i < toIndex.length; i += FILE_FETCH_BATCH_SIZE) {
    const batch = toIndex.slice(i, i + FILE_FETCH_BATCH_SIZE);

    const contents = await Promise.all(
      batch.map(async (path) => {
        const content = await fetchFileContent(
          owner,
          repo,
          path,
          newSha,
          token
        );
        return { path, content };
      })
    );

    const allSegments: CodeSegment[] = [];
    for (const { path, content } of contents) {
      if (!content) continue;
      // Remove old segments for this file before re-indexing
      await removeFileSegments(owner, repo, path, env);
      const language = detectLanguage(path);
      const segments = extractSegments(path, content, language);
      allSegments.push(...segments);
    }

    if (allSegments.length > 0) {
      await enrichSegmentsWithLLM(allSegments, env);
      await storeSegments(owner, repo, allSegments, env);
      await generateAndStoreEmbeddings(owner, repo, allSegments, env);
      totalSegments += allSegments.length;
    }
  }

  // Update repo profile
  const stack = await detectTelemetryStack(owner, repo, env);
  const timestamp = new Date().toISOString();
  await env.TELESCOPE_DB.prepare(
    `UPDATE repo_profiles SET last_indexed_at = ?, last_indexed_sha = ?, telemetry_stack = ? WHERE owner = ? AND repo = ?`
  )
    .bind(timestamp, newSha, JSON.stringify(stack), owner, repo)
    .run();

  // Regenerate telemetry architecture summary
  await generateTelemetrySummary(owner, repo, env);

  console.log(
    `[indexer] Incremental: ${totalSegments} segments from ${toIndex.length} files`
  );

  return {
    owner,
    repo,
    segmentsIndexed: totalSegments,
    filesProcessed: toIndex.length,
    sha: newSha,
    timestamp,
  };
}

async function storeSegments(
  owner: string,
  repo: string,
  segments: CodeSegment[],
  env: Env
): Promise<void> {
  const stmt = env.TELESCOPE_DB.prepare(
    `INSERT INTO telemetry_inventory (owner, repo, file_path, segment_type, language, content, context, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner, repo, file_path, segment_type, content) DO UPDATE SET
       indexed_at = excluded.indexed_at,
       context = excluded.context`
  );

  const now = new Date().toISOString();
  const batch = segments.map((seg) =>
    stmt.bind(
      owner,
      repo,
      seg.filePath,
      seg.segmentType,
      seg.language,
      seg.content,
      seg.context ?? null,
      now
    )
  );

  // D1 batch limit is 100 statements
  for (let i = 0; i < batch.length; i += 100) {
    await env.TELESCOPE_DB.batch(batch.slice(i, i + 100));
  }
}

async function generateAndStoreEmbeddings(
  owner: string,
  repo: string,
  segments: CodeSegment[],
  env: Env
): Promise<void> {
  // Generate embeddings in batches
  for (let i = 0; i < segments.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = segments.slice(i, i + EMBEDDING_BATCH_SIZE);
    const texts = batch.map(
      (seg) => seg.context ?? `${seg.segmentType} in ${seg.filePath}: ${seg.content}`
    );

    const embeddings = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: texts,
    }) as { data?: number[][]; shape?: number[] };

    if (!embeddings.data || embeddings.data.length === 0) continue;

    const vectors = await Promise.all(
      batch.map(async (seg, idx) => ({
        id: await vectorId(owner, repo, seg.filePath, seg.segmentType, seg.lineStart),
        values: embeddings.data![idx],
        metadata: {
          owner,
          repo,
          filePath: seg.filePath,
          segmentType: seg.segmentType,
          language: seg.language,
          lineStart: seg.lineStart,
          lineEnd: seg.lineEnd,
        },
      }))
    );

    await env.CODE_EMBEDDINGS.upsert(vectors);
  }
}

async function removeFileSegments(
  owner: string,
  repo: string,
  filePath: string,
  env: Env
): Promise<void> {
  // Remove from D1
  await env.TELESCOPE_DB.prepare(
    `DELETE FROM telemetry_inventory WHERE owner = ? AND repo = ? AND file_path = ?`
  )
    .bind(owner, repo, filePath)
    .run();

  // For Vectorize, we'd need to know the vector IDs.
  // Since our IDs follow a predictable pattern, query D1 first.
  // After D1 delete, we can't recover the IDs — so we do a best-effort
  // approach by querying and deleting vectors with matching metadata.
  // Vectorize doesn't support metadata-based deletion, so stale vectors
  // will be overwritten on re-index (same ID pattern) or ignored via
  // metadata filtering at query time.
}

async function detectTelemetryStack(
  owner: string,
  repo: string,
  env: Env
): Promise<string[]> {
  const result = await env.TELESCOPE_DB.prepare(
    `SELECT DISTINCT content FROM telemetry_inventory WHERE owner = ? AND repo = ?`
  )
    .bind(owner, repo)
    .all<{ content: string }>();

  const allContent = result.results.map((r) => r.content).join("\n");
  const stack: Set<string> = new Set();

  const stackPatterns: [RegExp, string][] = [
    [/prom[_-]?client|prometheus/i, "prometheus"],
    [/opentelemetry|otel/i, "opentelemetry"],
    [/datadog|dd-trace|ddtrace/i, "datadog"],
    [/statsd/i, "statsd"],
    [/pino/i, "pino"],
    [/winston/i, "winston"],
    [/bunyan/i, "bunyan"],
    [/structlog/i, "structlog"],
    [/zerolog/i, "zerolog"],
    [/zap/i, "zap"],
    [/logrus/i, "logrus"],
    [/slog/i, "slog"],
    [/tracing_subscriber|tracing::/i, "rust-tracing"],
    [/log4[j2]?/i, "log4j"],
    [/slf4j/i, "slf4j"],
    [/sentry/i, "sentry"],
    [/newrelic/i, "newrelic"],
    [/bugsnag/i, "bugsnag"],
    [/rollbar/i, "rollbar"],
    [/jaeger/i, "jaeger"],
    [/zipkin/i, "zipkin"],
    [/micrometer/i, "micrometer"],
  ];

  for (const [pattern, name] of stackPatterns) {
    if (pattern.test(allContent)) {
      stack.add(name);
    }
  }

  return Array.from(stack);
}

async function generateTelemetrySummary(
  owner: string,
  repo: string,
  env: Env
): Promise<void> {
  // Fetch enriched segments from D1
  const result = await env.TELESCOPE_DB.prepare(
    `SELECT file_path, segment_type, context, content
     FROM telemetry_inventory
     WHERE owner = ? AND repo = ? AND context IS NOT NULL
     ORDER BY segment_type, file_path
     LIMIT 50`
  )
    .bind(owner, repo)
    .all<{ file_path: string; segment_type: string; context: string; content: string }>();

  if (result.results.length === 0) {
    console.log(`[indexer] No enriched segments for summary generation`);
    return;
  }

  // Group by type for the prompt
  const grouped = new Map<string, string[]>();
  for (const row of result.results) {
    const list = grouped.get(row.segment_type) ?? [];
    list.push(`- ${row.file_path}: ${row.context}`);
    grouped.set(row.segment_type, list);
  }

  let inventory = "";
  for (const [type, items] of grouped) {
    inventory += `\n### ${type} (${items.length})\n${items.join("\n")}\n`;
  }

  const prompt = `Below is an inventory of telemetry and observability code found in the repository ${owner}/${repo}.

Write a concise summary (max 400 words) of this repository's telemetry architecture covering:
1. What telemetry stack/libraries are used
2. How metrics are organized (centralized module? per-service? inline?)
3. How tracing is set up (middleware? manual spans? auto-instrumentation?)
4. How logging is configured
5. What conventions the codebase follows
6. Any notable gaps or inconsistencies

${inventory}`;

  try {
    const response = await env.AI.run(
      "@cf/meta/llama-3.2-3b-instruct",
      { prompt }
    ) as { response?: string };

    const summary = response.response?.trim();
    if (summary && summary.length > 50) {
      await env.TELESCOPE_DB.prepare(
        `UPDATE repo_profiles SET telemetry_summary = ? WHERE owner = ? AND repo = ?`
      )
        .bind(summary, owner, repo)
        .run();
      console.log(`[indexer] Generated telemetry summary (${summary.length} chars)`);
    }
  } catch (err) {
    console.warn(`[indexer] Failed to generate telemetry summary: ${err}`);
  }
}

export async function querySimilarPatterns(
  query: string,
  owner: string,
  repo: string,
  env: Env,
  topK: number = 5
): Promise<{ filePath: string; segmentType: string; content: string; context: string | null; score: number }[]> {
  // Generate embedding for the query
  const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [query],
  }) as { data?: number[][]; shape?: number[] };

  if (!embedding.data || embedding.data.length === 0) return [];

  const results = await env.CODE_EMBEDDINGS.query(embedding.data[0], {
    topK,
    filter: { owner, repo },
  });

  if (!results.matches || results.matches.length === 0) return [];

  // Fetch the actual content from D1 for the matching segments
  const enriched = await Promise.all(
    results.matches.map(async (match) => {
      const meta = match.metadata as Record<string, string>;
      const row = await env.TELESCOPE_DB.prepare(
        `SELECT content, context FROM telemetry_inventory
         WHERE owner = ? AND repo = ? AND file_path = ? AND segment_type = ?
         LIMIT 1`
      )
        .bind(owner, repo, meta.filePath, meta.segmentType)
        .first<{ content: string; context: string | null }>();

      return {
        filePath: meta.filePath,
        segmentType: meta.segmentType,
        content: row?.content ?? "",
        context: row?.context ?? null,
        score: match.score,
      };
    })
  );

  return enriched.filter((e) => e.content);
}
