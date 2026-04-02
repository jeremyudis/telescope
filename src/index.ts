import { routeAgentRequest, getAgentByName } from "agents";
import type { TelescopeAgent } from "./agent";
import { handleQueue } from "./queue";
import { fetchCompare } from "./github";
import { checkRecommendationFollowUp } from "./feedback";
import type { IndexingJob } from "./types";

export { TelescopeAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Direct HTTP trigger: review a PR
    if (url.pathname === "/review" && request.method === "POST") {
      return handleReview(request, env, false);
    }

    // Direct HTTP trigger: review and post comment
    if (url.pathname === "/review-and-comment" && request.method === "POST") {
      return handleReview(request, env, true);
    }

    // Index a repository
    if (url.pathname === "/index" && request.method === "POST") {
      return handleIndex(request, env);
    }

    // GitHub webhook
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env, ctx);
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({ status: "ok", agent: "telescope" });
    }

    // Agent framework routing (WebSocket, RPC)
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch, env: Env) {
    await handleQueue(batch as MessageBatch<IndexingJob>, env);
  },
} satisfies ExportedHandler<Env>;

async function handleReview(
  request: Request,
  env: Env,
  postComment: boolean
): Promise<Response> {
  let body: { owner?: string; repo?: string; pullNumber?: number };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { owner, repo, pullNumber } = body;
  if (!owner || !repo || !pullNumber) {
    return Response.json(
      { error: "Missing required fields: owner, repo, pullNumber" },
      { status: 400 }
    );
  }

  try {
    const agent = await getAgentByName<Env, TelescopeAgent>(
      env.TELESCOPE_AGENT,
      `${owner}/${repo}`
    );

    const result = postComment
      ? await agent.reviewAndComment({ owner, repo, pullNumber })
      : await agent.reviewPR({ owner, repo, pullNumber });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleIndex(
  request: Request,
  env: Env
): Promise<Response> {
  let body: { owner?: string; repo?: string; ref?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { owner, repo, ref } = body;
  if (!owner || !repo) {
    return Response.json(
      { error: "Missing required fields: owner, repo" },
      { status: 400 }
    );
  }

  // Queue a full indexing job
  try {
    await env.INDEXING_QUEUE.send({
      owner,
      repo,
      ref: ref ?? "",
      mode: "full",
    } satisfies IndexingJob);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json(
    { status: "accepted", message: `Indexing queued for ${owner}/${repo}` },
    { status: 202 }
  );
}

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const event = request.headers.get("X-GitHub-Event");

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle push events — trigger incremental re-indexing
  if (event === "push") {
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const defaultBranch = payload.repository.default_branch;
    const ref = payload.ref;

    // Only re-index pushes to default branch
    if (ref === `refs/heads/${defaultBranch}`) {
      const newSha = payload.after;
      const oldSha = payload.before;

      ctx.waitUntil(
        env.INDEXING_QUEUE.send({
          owner,
          repo,
          ref: newSha,
          mode: "incremental",
          previousSha: oldSha,
        } satisfies IndexingJob)
      );

      return Response.json(
        { status: "accepted", action: "incremental-index", owner, repo },
        { status: 202 }
      );
    }

    return Response.json({
      status: "ignored",
      reason: "push not to default branch",
    });
  }

  // Handle pull_request events — trigger review
  if (event === "pull_request") {
    if (payload.action !== "opened" && payload.action !== "synchronize") {
      return Response.json({
        status: "ignored",
        reason: `action: ${payload.action}`,
      });
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const pullNumber = payload.number;

    // Fire and forget — don't block the webhook response
    ctx.waitUntil(
      (async () => {
        // On synchronize (new commits pushed), check if previous recommendations were addressed
        if (payload.action === "synchronize" && payload.before) {
          try {
            const changedFiles = await fetchCompare(
              owner, repo, payload.before, payload.pull_request.head.sha, env.GITHUB_TOKEN
            );
            await checkRecommendationFollowUp(
              owner, repo, pullNumber, changedFiles.map((f) => f.filename), env
            );
          } catch (err) {
            console.warn(`[webhook] Feedback check failed: ${err}`);
          }
        }

        const agent = await getAgentByName<Env, TelescopeAgent>(
          env.TELESCOPE_AGENT,
          `${owner}/${repo}`
        );
        await agent.reviewAndComment({ owner, repo, pullNumber });
      })()
    );

    return Response.json(
      { status: "accepted", owner, repo, pullNumber },
      { status: 202 }
    );
  }

  return Response.json({
    status: "ignored",
    reason: `unsupported event: ${event}`,
  });
}
