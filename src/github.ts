import type { FileChange, PRMetadata, DependencyManifest } from "./types";

const GITHUB_API = "https://api.github.com";

const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /poetry\.lock$/,
  /Pipfile\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.svg$/,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.ico$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
  /^vendor\//,
  /^node_modules\//,
  /^\.git\//,
  /\.generated\.\w+$/,
  /\.pb\.\w+$/,
  /\.snap$/,
  /\.test\.\w+$/,
  /\.spec\.\w+$/,
  /__snapshots__\//,
];

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".c": "c",
  ".swift": "swift",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
  ".php": "php",
};

const MANIFEST_PATHS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
];

function shouldSkip(filename: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(filename));
}

function detectLanguage(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf("."));
  return LANGUAGE_MAP[ext] ?? "unknown";
}

async function githubFetch(
  path: string,
  token: string,
  accept?: string
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept ?? "application/vnd.github.v3+json",
      "User-Agent": "telescope-agent",
    },
  });
}

export async function fetchPRMetadata(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string
): Promise<PRMetadata> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/pulls/${pullNumber}`,
    token
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch PR metadata: ${res.status} ${res.statusText}`
    );
  }
  const data = (await res.json()) as any;
  return {
    title: data.title,
    description: data.body ?? "",
    baseRef: data.base.ref,
    headRef: data.head.ref,
    headSha: data.head.sha,
  };
}

export async function fetchPRFiles(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string
): Promise<FileChange[]> {
  const files: FileChange[] = [];
  let page = 1;

  while (true) {
    const res = await githubFetch(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      token
    );
    if (!res.ok) {
      throw new Error(
        `Failed to fetch PR files: ${res.status} ${res.statusText}`
      );
    }
    const data = (await res.json()) as any[];
    if (data.length === 0) break;

    for (const file of data) {
      if (shouldSkip(file.filename)) continue;

      files.push({
        filename: file.filename,
        status: file.status as FileChange["status"],
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? "",
        language: detectLanguage(file.filename),
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return files;
}

export async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string
): Promise<string | null> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`,
    token,
    "application/vnd.github.v3.raw"
  );
  if (!res.ok) return null;
  return res.text();
}

export async function fetchDependencyManifests(
  owner: string,
  repo: string,
  ref: string,
  token: string
): Promise<DependencyManifest[]> {
  const results = await Promise.all(
    MANIFEST_PATHS.map(async (path) => {
      const content = await fetchFileContent(owner, repo, path, ref, token);
      if (content === null) return null;
      return { path, content };
    })
  );
  return results.filter((r): r is DependencyManifest => r !== null);
}

export async function postReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
  body: string
): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${pullNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "telescope-agent",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to post comment: ${res.status} ${res.statusText}`
    );
  }
}
