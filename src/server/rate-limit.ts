import type { NextFunction, Request, Response } from "express";

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export function createRateLimiter(options?: Partial<RateLimiterOptions>) {
  const hits = new Map<string, number[]>();

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const windowMs =
      options?.windowMs ??
      Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || "60000"));
    const maxRequests =
      options?.maxRequests ??
      Math.max(1, Number(process.env.RATE_LIMIT_MAX_REQUESTS || "30"));

    const clientIp =
      req.ip ||
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;

    const existing = hits.get(clientIp) || [];
    const recent = existing.filter((t) => t > cutoff);

    if (recent.length >= maxRequests) {
      const retryAfterSec = Math.ceil((recent[0] + windowMs - now) / 1000);
      res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
      res.status(429).json({
        ok: false,
        error: "Too many requests. Please wait a moment before trying again.",
      });
      return;
    }

    recent.push(now);
    hits.set(clientIp, recent);

    // Periodic pruning to avoid unbounded memory growth
    if (hits.size > 1000) {
      for (const [key, timestamps] of hits.entries()) {
        if (timestamps.every((t) => t <= cutoff)) {
          hits.delete(key);
        }
      }
    }

    next();
  };
}
