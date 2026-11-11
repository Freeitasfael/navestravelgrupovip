const {
  getRedisConfig,
  redisPipeline,
  checkAdminAuth,
  parseJsonBody,
  pairsToStringObject,
} = require('./_redis');

const PIXEL_KEY = 'nt:config:pixels';

function normalizePixels(raw = {}) {
  return {
    metaPixelId: String(raw.metaPixelId || process.env.META_PIXEL_ID || '').trim(),
    ga4Id: String(raw.ga4Id || process.env.GA4_ID || '').trim().toUpperCase(),
    gadsSendTo: String(raw.gadsSendTo || process.env.GADS_SEND_TO || '').trim(),
  };
}

function validatePixels(input) {
  const metaPixelId = String(input.metaPixelId || '').trim();
  const ga4Id = String(input.ga4Id || '').trim().toUpperCase();
  const gadsSendTo = String(input.gadsSendTo || '').trim();

  if (metaPixelId && !/^\d{6,24}$/.test(metaPixelId)) {
    return { error: 'Meta Pixel ID inválido (use apenas números, ex: 123456789012345).' };
  }
  if (ga4Id && !/^G-[A-Z0-9]{4,20}$/.test(ga4Id)) {
    return { error: 'Google Analytics 4 ID inválido (formato esperado: G-XXXXXXXXXX).' };
  }
  if (gadsSendTo && !/^AW-[A-Z0-9]{5,20}(\/[A-Za-z0-9_-]{3,40})?$/i.test(gadsSendTo)) {
    return { error: 'Google Ads Conversion inválido (formato esperado: AW-123456789/AbCdEfGhIj).' };
  }
  return { values: { metaPixelId, ga4Id, gadsSendTo } };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    if (!getRedisConfig()) {
      return res.status(200).json(normalizePixels());
    }
    try {
      const [raw] = await redisPipeline([['HGETALL', PIXEL_KEY]]);
      const stored = pairsToStringObject(raw);
      return res.status(200).json(normalizePixels(stored));
    } catch {
      return res.status(200).json(normalizePixels());
    }
  }

  if (req.method === 'POST') {
    res.setHeader('Cache-Control', 'no-store');
    const { authorized } = checkAdminAuth(req);
    if (!authorized) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!getRedisConfig()) {
      return res.status(503).json({ error: 'Redis not configured' });
    }
    const body = await parseJsonBody(req);
    const { error, values } = validatePixels(body);
    if (error) {
      return res.status(400).json({ error });
    }
    try {
      await redisPipeline([
        [
          'HSET',
          PIXEL_KEY,
          'metaPixelId',
          values.metaPixelId,
          'ga4Id',
          values.ga4Id,
          'gadsSendTo',
          values.gadsSendTo,
        ],
      ]);
      return res.status(200).json({ ok: true, ...values });
    } catch (err) {
      console.error('Pixels save error:', err);
      return res.status(500).json({ error: 'Failed to save pixel settings' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
