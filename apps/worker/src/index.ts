import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "@agentforge/config";

const config = loadConfig();

if (!config.redisUrl) {
  console.log("AgentForge worker started without REDIS_URL; queue processing is disabled.");
} else {
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null
  });

  const worker = new Worker(
    "merge-guard-evaluations",
    async (job) => {
      console.log("Processing Merge Guard evaluation job", {
        jobId: job.id,
        name: job.name
      });
      return {
        processedAt: new Date().toISOString(),
        advisory:
          "Worker scaffold processed the job envelope. Deterministic evaluation is API-wired."
      };
    },
    { connection }
  );

  worker.on("completed", (job) => {
    console.log("Merge Guard evaluation job completed", { jobId: job.id });
  });
  worker.on("failed", (job, error) => {
    console.error("Merge Guard evaluation job failed", {
      jobId: job?.id,
      message: error.message
    });
  });
}
