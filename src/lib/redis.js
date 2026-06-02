import Redis from "ioredis";

const client = new Redis(process.env.REDIS_URL);

const PREFIX = "click2kart";

// Log connection
client.on("connect", () => {
  console.log("🚀 Upstash Redis (TCP) Client Connected");
});

client.on("error", (err) => {
  console.error("❌ Redis Connection Error:", err);
});

/**
 * Get or set cache helper with prefix, logging and metrics
 */
export const getOrSetCache = async (key, cb, ttl = 3600) => {
  const fullKey = `${PREFIX}:${key}`;
  try {
    const cachedValue = await client.get(fullKey);

    if (cachedValue) {
      console.log(`✅ [CACHE HIT]: ${fullKey}`);
      // Tracking Hit Metric
      client.incr(`${PREFIX}:metrics:hits`).catch(() => {});

      try {
        return JSON.parse(cachedValue);
      } catch {
        return cachedValue;
      }
    }

    console.log(`❌ [CACHE MISS]: ${fullKey}`);
    // Tracking Miss Metric
    client.incr(`${PREFIX}:metrics:misses`).catch(() => {});

    const freshData = await cb();
    if (freshData !== undefined && freshData !== null) {
      await client.set(fullKey, JSON.stringify(freshData), "EX", ttl);
    }
    return freshData;
  } catch (error) {
    console.error(`⚠️ Cache error for key ${fullKey}:`, error);
    return await cb(); // Fallback to DB
  }
};

/**
 * Delete cache key(s) or patterns
 */
export const delCache = async (keys) => {
  try {
    const prepareKey = (k) => (k.startsWith(PREFIX) ? k : `${PREFIX}:${k}`);

    if (Array.isArray(keys)) {
      const keysToDelete = [];
      for (const key of keys) {
        const fullKey = prepareKey(key);
        if (fullKey.includes("*")) {
          const matchingKeys = await client.keys(fullKey);
          if (matchingKeys.length > 0) keysToDelete.push(...matchingKeys);
        } else {
          keysToDelete.push(fullKey);
        }
      }
      if (keysToDelete.length > 0) await client.del(...keysToDelete);
    } else {
      const fullKey = prepareKey(keys);
      if (fullKey.includes("*")) {
        const matchingKeys = await client.keys(fullKey);
        if (matchingKeys.length > 0) await client.del(...matchingKeys);
      } else {
        await client.del(fullKey);
      }
    }
  } catch (error) {
    console.error("Redis Delete Error:", error);
  }
};

/**
 * Get current version of a cache namespace
 */
export const getCacheVersion = async (namespace) => {
  try {
    const version = await client.get(`${PREFIX}:version:${namespace}`);
    return version || "1";
  } catch {
    return "1";
  }
};

/**
 * Increment version of a cache namespace
 */
export const bumpCacheVersion = async (namespace) => {
  try {
    await client.incr(`${PREFIX}:version:${namespace}`);
  } catch (error) {
    console.error(`Redis bump version error for ${namespace}:`, error);
  }
};

// Connect Redis
export const connectRedis = async () => {
  // ioredis connects automatically
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
};

/**
 * Rate limiting logic using Redis INCR
 */
export const incrRateLimit = async (key) => {
  return await client.incr(key);
};

export const expireRateLimit = async (key, seconds) => {
  return await client.expire(key, seconds);
};

export const ttlRateLimit = async (key) => {
  return await client.ttl(key);
};

/**
 * Get Cache Metrics (Hits/Misses)
 */
export const getCacheMetrics = async () => {
  try {
    const [hits, misses] = await client.mget(
      `${PREFIX}:metrics:hits`,
      `${PREFIX}:metrics:misses`
    );
    return {
      hits: parseInt(hits || 0),
      misses: parseInt(misses || 0),
      hitRate: hits
        ? (
            (parseInt(hits) / (parseInt(hits) + parseInt(misses || 0))) *
            100
          ).toFixed(2) + "%"
        : "0%",
    };
  } catch (error) {
    console.error("Error fetching metrics:", error);
    return { hits: 0, misses: 0, hitRate: "0%" };
  }
};

export default client;
