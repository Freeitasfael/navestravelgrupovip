const TIMEZONE = 'America/Sao_Paulo';

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }
  return { url: url.replace(/\/$/, ''), token };
}

async function redisPipeline(commands) {
  const cfg = getRedisConfig();
  if (!cfg) {
    const err = new Error('Redis storage is not configured');
    err.code = 'STORAGE_NOT_CONFIGURED';
    throw err;
  }
  const response = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis pipeline failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  return data.map((entry) => {
    if (entry && entry.error) {
      throw new Error(`Redis command error: ${entry.error}`);
    }
    return entry ? entry.result : null;
  });
}

function getSaoPauloParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const day = `${map.year}-${map.month}-${map.day}`;
  return {
    day,
    hour: map.hour,
    timestamp: `${day} ${map.hour}:${map.minute}:${map.second}`,
  };
}

function getRecentDays(count = 14) {
  const days = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    days.push(getSaoPauloParts(d).day);
  }
  return days;
}

function pairsToObject(raw) {
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  const out = {};
  for (let i = 0; i < raw.length; i += 2) {
    out[String(raw[i])] = Number(raw[i + 1]) || 0;
  }
  return out;
}

module.exports = {
  getRedisConfig,
  redisPipeline,
  getSaoPauloParts,
  getRecentDays,
  pairsToObject,
};

