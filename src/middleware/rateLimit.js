import client, { incrRateLimit, expireRateLimit, ttlRateLimit } from "../lib/redis.js";

/**
 * Redis-based rate limiting middleware
 * @param {string} namespace - Unique identifier for this limit (e.g. 'login', 'otp')
 * @param {number} limit - Maximum number of requests allowed
 * @param {number} windowInSeconds - Time window in seconds
 */
export const rateLimit = (namespace, limit = 5, windowInSeconds = 60) => {
  return async (req, res, next) => {
    try {
      // Upstash REST is always "open" conceptually as it's HTTP
      const ip = req.headers["x-forwarded-for"] || req.ip;
      const key = `click2kart:ratelimit:${namespace}:${ip}`;

      const requests = await incrRateLimit(key);

      if (requests === 1) {
        await expireRateLimit(key, windowInSeconds);
      }

      const ttl = await ttlRateLimit(key);

      // Add headers for the client to see their limits
      res.set("X-RateLimit-Limit", limit);
      res.set("X-RateLimit-Remaining", Math.max(0, limit - requests));
      res.set("X-RateLimit-Reset", ttl);

      if (requests > limit) {
        console.log(`🚫 [RATE LIMIT]: ${namespace} exceeded by ${ip}`);
        return res.status(429).json({
          error: "too_many_requests",
          retryIn: ttl,
          message: `Too many requests. Please try again in ${ttl} seconds.`
        });
      }

      next();
    } catch (error) {
      console.error("Rate limiting error:", error);
      next(); // Fallback: allow request if Redis fails
    }
  };
};
