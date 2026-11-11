const { redisPipeline, parseJsonBody, getSaoPauloParts } = require('./_redis');

const BOT_RE = /bot|crawler|spider|headless|lighthouse|vercel-screenshot|pingdom|uptime/i;

function sanitizeToken(value, fallback = '', maxLen = 48) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, maxLen);
  return cleaned || fallback;
}

function sanitizeLabel(value, fallback = '', maxLen = 64) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .trim()
    .replace(/[\r\n\t|<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, maxLen);
  return cleaned || fallback;
}

function getGeoLabel(req) {
  const rawCity = String(req.headers['x-vercel-ip-city'] || '');
  let city = rawCity;
  try {
    city = decodeURIComponent(rawCity);
  } catch {}
  city = sanitizeLabel(city, '', 40);
  const region = sanitizeToken(String(req.headers['x-vercel-ip-country-region'] || ''), '', 10);
  const country = sanitizeToken(String(req.headers['x-vercel-ip-country'] || ''), '', 8);

  if (city && region) return `${city} - ${region}`;
  if (city && country) return `${city} (${country})`;
  if (region && country) return `${region} (${country})`;
  if (country) return country;
  return '';
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

  const body = await parseJsonBody(req);
  const type = body.type;
  if (!['pageview', 'vip_click', 'link_click'].includes(type)) {
    return res.status(400).json({ error: 'Invalid event type' });
  }

  const vid = sanitizeToken(body.vid, '', 64);
  const loc = sanitizeToken(body.loc, 'unknown', 32);
  const source = sanitizeToken(String(body.source || '').toLowerCase(), 'direto', 48);
  const medium = sanitizeToken(String(body.medium || '').toLowerCase(), 'none', 32);
  const campaign = sanitizeLabel(String(body.campaign || ''), '', 64);
  const content = sanitizeLabel(String(body.content || ''), '', 64);
  const device = body.device === 'mobile' ? 'mobile' : 'desktop';
  const geo = getGeoLabel(req);
  const channelKey = `${source}|${medium}`;
  const campaignKey = campaign ? `${source}|${campaign}` : '';
  const { day, hour, timestamp } = getSaoPauloParts();

  const commands = [];
  let recentEntry = null;

  if (type === 'pageview') {
    commands.push(
      ['INCR', 'nt:views:total'],
      ['INCR', `nt:views:day:${day}`],
      ['HINCRBY', `nt:views:hours:${day}`, hour, 1],
      ['HINCRBY', 'nt:devices', device, 1],
      ['HINCRBY', 'nt:sources', source, 1],
      ['HINCRBY', 'nt:channels:views', channelKey, 1]
    );
    if (campaignKey) {
      commands.push(['HINCRBY', 'nt:campaigns:views', campaignKey, 1]);
    }
    if (geo) {
      commands.push(['HINCRBY', 'nt:geo:views', geo, 1]);
    }
    if (vid) {
      commands.push(
        ['PFADD', 'nt:uniques:total', vid],
        ['PFADD', `nt:uniques:day:${day}`, vid]
      );
    }
    recentEntry = { ts: timestamp, type: 'pageview', device, source, medium, campaign, content, geo };
  } else if (type === 'vip_click') {
    commands.push(
      ['INCR', 'nt:clicks:vip:total'],
      ['INCR', `nt:clicks:vip:day:${day}`],
      ['HINCRBY', 'nt:clicks:vip:loc', loc, 1],
      ['HINCRBY', 'nt:channels:clicks', channelKey, 1]
    );
    if (campaignKey) {
      commands.push(['HINCRBY', 'nt:campaigns:clicks', campaignKey, 1]);
    }
    if (geo) {
      commands.push(['HINCRBY', 'nt:geo:clicks', geo, 1]);
    }
    if (vid) {
      commands.push(['PFADD', 'nt:clicks:vip:uniques', vid]);
    }
    recentEntry = { ts: timestamp, type: 'vip_click', loc, device, source, medium, campaign, content, geo };
  } else if (type === 'link_click') {
    commands.push(['HINCRBY', 'nt:clicks:other', loc, 1]);
    recentEntry = { ts: timestamp, type: 'link_click', loc, device, source, medium, campaign, geo };
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
