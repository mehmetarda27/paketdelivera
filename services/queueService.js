const JOB_TYPES = Object.freeze({
  ASSIGNMENT_RETRY: "assignment.retry",
  WEBHOOK_CALLBACK_RETRY: "webhook.callback.retry",
  PLATFORM_STATUS_SYNC: "platform.status.sync",
});

const DEFAULT_RETRY_POLICY = Object.freeze({
  attempts: 5,
  backoff: {
    type: "exponential",
    delayMs: 30000,
  },
  deadLetterAfterAttempts: 5,
});

class QueueService {
  constructor({ redisUrl, logger } = {}) {
    this.redisUrl = redisUrl;
    this.logger = logger;
    this.mode = redisUrl ? "bullmq_configured" : "inline";
    this.queues = new Map();
    this.initialized = false;
    this.initError = "";
  }

  initialize() {
    if (this.initialized || !this.redisUrl) {
      return;
    }
    this.initialized = true;

    try {
      const { Queue } = require("bullmq");
      const connection = { url: this.redisUrl };
      Object.values(JOB_TYPES).forEach((jobType) => {
        this.queues.set(jobType, new Queue(jobType, { connection }));
      });
      this.logger?.info?.("BullMQ queues configured", { jobs: Object.values(JOB_TYPES) });
    } catch (error) {
      this.initError = error.message;
      this.mode = "inline";
      this.logger?.warn?.("BullMQ unavailable; queue service remains inline", { error: error.message });
    }
  }

  async enqueue(type, payload = {}, options = {}) {
    this.initialize();
    const queue = this.queues.get(type);
    if (!queue) {
      return {
        ok: false,
        mode: "inline",
        reason: this.redisUrl ? this.initError || "queue_not_ready" : "redis_not_configured",
      };
    }

    try {
      const job = await queue.add(type, payload, {
        attempts: options.attempts || DEFAULT_RETRY_POLICY.attempts,
        backoff: options.backoff || {
          type: DEFAULT_RETRY_POLICY.backoff.type,
          delay: DEFAULT_RETRY_POLICY.backoff.delayMs,
        },
        delay: options.delayMs || 0,
        removeOnComplete: 1000,
        removeOnFail: false,
      });
      return { ok: true, mode: "bullmq", jobId: job.id };
    } catch (error) {
      this.logger?.warn?.("Queue enqueue failed; caller should use inline fallback", { type, error: error.message });
      return { ok: false, mode: "inline", reason: error.message };
    }
  }

  health() {
    return {
      mode: this.mode,
      redisUrlConfigured: Boolean(this.redisUrl),
      jobTypes: Object.values(JOB_TYPES),
      initialized: this.initialized,
      initError: this.initError || null,
      retryPolicy: DEFAULT_RETRY_POLICY,
    };
  }
}

function createQueueService(options = {}) {
  return new QueueService(options);
}

module.exports = {
  createQueueService,
  JOB_TYPES,
  DEFAULT_RETRY_POLICY,
};
