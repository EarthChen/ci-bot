export interface RateLimitOptions {
	readonly max: number;
	readonly windowMs: number;
}

/** Fixed-window in-memory rate limiter (per key, e.g. client IP). */
export class MemoryRateLimiter {
	private readonly buckets = new Map<string, { count: number; resetAt: number }>();

	constructor(private readonly opts: RateLimitOptions) {}

	check(key: string): boolean {
		const now = Date.now();
		let bucket = this.buckets.get(key);
		if (!bucket || now >= bucket.resetAt) {
			bucket = { count: 0, resetAt: now + this.opts.windowMs };
			this.buckets.set(key, bucket);
		}
		bucket.count++;
		return bucket.count <= this.opts.max;
	}
}
