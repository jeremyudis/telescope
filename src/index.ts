import { routeAgentRequest, getAgentByName } from "agents";
import type { TelescopeAgent } from "./agent";

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

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const event = request.headers.get("X-GitHub-Event");
  if (event !== "pull_request") {
    return Response.json({
      status: "ignored",
      reason: "not a pull_request event",
    });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

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
