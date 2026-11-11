const crypto = require('crypto');
const {
  getRedisConfig,
  redisPipeline,
  getSaoPauloParts,
  getRecentDays,
  pairsToObject,
} = require('./_redis');

function checkAuth(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return { authorized: true, authEnabled: false };
  const provided = String(req.headers['x-admin-password'] || '');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  const match =
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf);
  return { authorized: match, authEnabled: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { authorized, authEnabled } = checkAuth(req);
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized', requiresAuth: true });
  }

  if (!getRedisConfig()) {
    return res.status(503).json({
      error: 'Armazenamento Redis ainda não conectado ao projeto na Vercel.',
      code: 'STORAGE_NOT_CONFIGURED',
    });
  }

  try {
    const days = getRecentDays(14);
    const { day: today, timestamp } = getSaoPauloParts();

    const commands = [
      ['GET', 'nt:views:total'],
      ['PFCOUNT', 'nt:uniques:total'],
      ['GET', 'nt:clicks:vip:total'],
      ['PFCOUNT', 'nt:clicks:vip:uniques'],
      ['HGETALL', 'nt:clicks:vip:loc'],
      ['HGETALL', 'nt:clicks:other'],
      ['HGETALL', 'nt:devices'],
      ['HGETALL', 'nt:sources'],
      ['HGETALL', `nt:views:hours:${today}`],
      ['LRANGE', 'nt:recent', 0, 29],
    ];

    for (const d of days) {
      commands.push(
        ['GET', `nt:views:day:${d}`],
        ['PFCOUNT', `nt:uniques:day:${d}`],
        ['GET', `nt:clicks:vip:day:${d}`]
      );
    }

    const results = await redisPipeline(commands);

    const totalViews = Number(results[0]) || 0;
    const totalUniques = Number(results[1]) || 0;
    const totalVipClicks = Number(results[2]) || 0;
    const uniqueVipClickers = Number(results[3]) || 0;
    const locations = pairsToObject(results[4]);
    const otherLinks = pairsToObject(results[5]);
    const devices = pairsToObject(results[6]);
    const sources = pairsToObject(results[7]);
    const rawHours = pairsToObject(results[8]);
    const rawRecent = Array.isArray(results[9]) ? results[9] : [];

    const recent = rawRecent
      .map((item) => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const daily = [];
    let idx = 10;
    for (const d of days) {
      daily.push({
        day: d,
        views: Number(results[idx]) || 0,
        uniques: Number(results[idx + 1]) || 0,
        vipClicks: Number(results[idx + 2]) || 0,
      });
      idx += 3;
    }

    const todayStats = daily[daily.length - 1] || {
      day: today,
      views: 0,
      uniques: 0,
      vipClicks: 0,
    };

    const hours = Array.from({ length: 24 }, (_, h) => {
      const key = String(h).padStart(2, '0');
      return { hour: key, views: Number(rawHours[key]) || 0 };
    });

    return res.status(200).json({
      authEnabled,
      generatedAt: timestamp,
      totals: {
        views: totalViews,
        uniques: totalUniques,
        vipClicks: totalVipClicks,
        uniqueVipClickers,
      },
      today: todayStats,
      daily,
      hours,
      locations,
      otherLinks,
      devices,
      sources,
      recent,
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
};

