const { redisPipeline, getSaoPauloParts } = require('./_redis');

const BOT_RE = /bot|crawler|spider|headless|lighthouse|vercel-screenshot|pingdom|uptime/i;

function sanitizeToken(value, fallback = 'unknown', maxLen = 48) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, maxLen);
  return cleaned || fallback;
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_RE.test(ua)) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const body = await parseBody(req);
  const type = body.type;
  if (!['pageview', 'vip_click', 'link_click'].includes(type)) {
    return res.status(400).json({ error: 'Invalid event type' });
  }

  const vid = sanitizeToken(body.vid, '', 64);
  const loc = sanitizeToken(body.loc, 'unknown', 32);
  const source = sanitizeToken(String(body.source || '').toLowerCase(), 'direto', 48);
  const device = body.device === 'mobile' ? 'mobile' : 'desktop';
  const { day, hour, timestamp } = getSaoPauloParts();

  const commands = [];
  let recentEntry = null;

  if (type === 'pageview') {
    commands.push(
      ['INCR', 'nt:views:total'],
      ['INCR', `nt:views:day:${day}`],
      ['HINCRBY', `nt:views:hours:${day}`, hour, 1],
      ['HINCRBY', 'nt:devices', device, 1],
      ['HINCRBY', 'nt:sources', source, 1]
    );
    if (vid) {
      commands.push(
        ['PFADD', 'nt:uniques:total', vid],
        ['PFADD', `nt:uniques:day:${day}`, vid]
      );
    }
    recentEntry = { ts: timestamp, type: 'pageview', device, source };
  } else if (type === 'vip_click') {
    commands.push(
      ['INCR', 'nt:clicks:vip:total'],
      ['INCR', `nt:clicks:vip:day:${day}`],
      ['HINCRBY', 'nt:clicks:vip:loc', loc, 1]
    );
    if (vid) {
      commands.push(['PFADD', 'nt:clicks:vip:uniques', vid]);
    }
    recentEntry = { ts: timestamp, type: 'vip_click', loc, device, source };
  } else if (type === 'link_click') {
    commands.push(['HINCRBY', 'nt:clicks:other', loc, 1]);
    recentEntry = { ts: timestamp, type: 'link_click', loc, device, source };
  }

  if (recentEntry) {
    commands.push(
      ['LPUSH', 'nt:recent', JSON.stringify(recentEntry)],
      ['LTRIM', 'nt:recent', 0, 39]
    );
  }

  try {
    await redisPipeline(commands);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err.code === 'STORAGE_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Storage not configured' });
    }
    console.error('Track error:', err);
    return res.status(500).json({ error: 'Failed to record event' });
  }
};

