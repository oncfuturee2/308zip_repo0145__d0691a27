export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface RetryableStatuses {
  retryable: number[];
  nonRetryable: number[];
}

export class RetryStrategy {
  private readonly config: RetryConfig;
  private readonly retryableStatuses: number[];
  private readonly nonRetryableStatuses: number[];

  constructor(config: RetryConfig = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    backoffMultiplier: 2
  }) {
    this.config = config;
    this.retryableStatuses = [408, 429, 500, 502, 503, 504];
    this.nonRetryableStatuses = [400, 401, 403, 404, 405, 406, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 422, 423, 424, 426, 428, 431, 451];
  }

  canRetry(statusCode: number | null | undefined): boolean {
    if (statusCode === null || statusCode === undefined || statusCode === 0) {
      return true;
    }

    if (this.nonRetryableStatuses.includes(statusCode)) {
      return false;
    }

    if (this.retryableStatuses.includes(statusCode)) {
      return true;
    }

    return statusCode >= 500;
  }

  canRetryByAttempt(attemptNumber: number): boolean {
    return attemptNumber < this.config.maxAttempts;
  }

  getNextDelayMs(attemptNumber: number): number {
    if (attemptNumber <= 0) {
      return 0;
    }

    const delay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attemptNumber - 1);
    return Math.min(delay, this.config.maxDelayMs);
  }

  getTotalAttemptsAvailable(attemptNumber: number): number {
    return Math.max(0, this.config.maxAttempts - attemptNumber);
  }

  isExhausted(attemptNumber: number): boolean {
    return attemptNumber >= this.config.maxAttempts;
  }

  getMaxAttempts(): number {
    return this.config.maxAttempts;
  }

  getConfig(): RetryConfig {
    return { ...this.config };
  }
}
