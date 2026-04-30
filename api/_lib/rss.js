// Minimale RSS/Atom-parser zonder externe dependencies.
// Pakt zowel <item> (RSS 2.0) als <entry> (Atom 1.0) blokken op en
// extraheert title, link/url, summary en datum. Geen schema-validatie;
// simpele regex-aanpak die in de praktijk voor de meeste publieke feeds
// werkt (Skipr, Zorgvisie, NU.nl, etc.).

function stripCdata(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function parseDate(s) {
  if (!s) return null;
  const d = new Date(stripCdata(s).trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractField(block, tag) {
  // Tags die als XML-element gecapsuleerd zijn: <title>...</title>
  // Houdt rekening met eventuele attributen.
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = block.match(re);
  return m ? stripCdata(m[1]) : '';
}

function extractLink(block) {
  // Atom <link href="..."/> of RSS <link>...</link>
  const atomMatch = block.match(/<link\b[^>]*?href=["']([^"']+)["'][^>]*\/?>/i);
  if (atomMatch) return atomMatch[1];
  const rssMatch = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  return rssMatch ? stripCdata(rssMatch[1]).trim() : '';
}

function parseFeed(xml) {
  const items = [];
  if (!xml || typeof xml !== 'string') return items;
  // Vang zowel <item ...>...</item> (RSS) als <entry ...>...</entry> (Atom).
  const blocks = xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/g) || [];
  for (const block of blocks) {
    const title = stripHtml(extractField(block, 'title'));
    const url = extractLink(block).trim();
    // Summary kandidaten in volgorde van voorkeur
    const desc = extractField(block, 'description')
              || extractField(block, 'summary')
              || extractField(block, 'content:encoded')
              || extractField(block, 'content');
    const dateStr = extractField(block, 'pubDate')
                 || extractField(block, 'published')
                 || extractField(block, 'updated')
                 || extractField(block, 'dc:date');
    const datum = parseDate(dateStr);
    if (!title) continue;
    items.push({
      title,
      url,
      summary: stripHtml(desc).slice(0, 600),
      datum,
    });
  }
  return items;
}

async function fetchFeed(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MarktRadar/1.0 (+signals-cron)', 'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml' },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return parseFeed(text);
  } finally {
    if (t) clearTimeout(t);
  }
}

module.exports = { parseFeed, fetchFeed, stripHtml };
