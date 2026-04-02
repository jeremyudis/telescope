import { indexRepository, updateIndex } from "./indexer";
import type { IndexingJob } from "./types";

export async function handleQueue(
  batch: MessageBatch<IndexingJob>,
  env: Env
): Promise<void> {
  for (const msg of batch.messages) {
    const job = msg.body;
    console.log(
      `[queue] Processing ${job.mode} index job for ${job.owner}/${job.repo}`
    );

    try {
      if (job.mode === "full") {
        await indexRepository(
          job.owner,
          job.repo,
          job.ref,
          env.GITHUB_TOKEN,
          env
        );
      } else if (job.mode === "incremental" && job.previousSha) {
        await updateIndex(
          job.owner,
          job.repo,
          job.previousSha,
          job.ref,
          env.GITHUB_TOKEN,
          env
        );
      }
      msg.ack();
    } catch (err) {
      console.error(
        `[queue] Failed to index ${job.owner}/${job.repo}: ${err}`
      );
      msg.retry();
    }
  }
}
