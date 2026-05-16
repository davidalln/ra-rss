#!/usr/bin/env node

/**
 * Pitchfork Album Reviews RSS reformatter
 *
 * Fetches Pitchfork's official RSS feed and rewrites each item title as
 * "Artist - Album" (stripping the score and other noise Pitchfork includes).
 *
 * Usage:
 *   node pitchfork-rss.js
 *
 * Env vars (all optional):
 *   OUTPUT_FILE=./pitchfork-album-reviews.xml
 *   DELAY_MS=500
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_FILE  = path.resolve(process.env.OUTPUT_FILE || './pitchfork-album-reviews.xml');
const DELAY_MS     = parseInt(process.env.DELAY_MS) || 500;

const FEED_URL = 'https://pitchfork.com/feed/feed-album-reviews/rss';

let fetch;

async function loadDeps() {
  try {
    fetch = (await import('node-fetch')).default;
  } catch {
    console.error('Missing dependency: run  npm install node-fetch');
    process.exit(1);
  }
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Extract text content between XML tags
function getTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  // Strip CDATA wrapper if present
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

// Pitchfork's RSS titles look like:
//   "Mk.gee: Two Star & The Dream Police"
//   "Charli XCX: Brat"
//   "Various Artists: Now That's What I Call Music"
// They use a colon+space as the separator between artist and album.
// Fall back to the raw title if we can't parse it cleanly.
function parseTitle(rawTitle) {
  // Strip HTML entities
  const decoded = rawTitle
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

  // Pitchfork uses "Artist: Album" format
  const colonIdx = decoded.indexOf(': ');
  if (colonIdx !== -1) {
    const artist = decoded.slice(0, colonIdx).trim();
    const album  = decoded.slice(colonIdx + 2).trim();
    return { artist, album, formatted: `${artist} – ${album}` };
  }

  // Fallback: return as-is
  return { artist: '', album: decoded, formatted: decoded };
}

async function fetchAndReformat() {
  console.log(`[${timestamp()}] Fetching Pitchfork RSS…`);

  const res = await fetch(FEED_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RSS-reformatter/1.0)',
      'Accept': 'application/rss+xml, application/xml, text/xml',
    },
    timeout: 15000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const xml = await res.text();

  // Split into individual <item> blocks
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  if (!itemBlocks.length) throw new Error('No items found in feed');

  console.log(`[${timestamp()}] Parsing ${itemBlocks.length} items…`);

  const items = itemBlocks.map(block => {
    const rawTitle   = getTag(block, 'title');
    const link       = getTag(block, 'link') || getTag(block, 'guid');
    const pubDate    = getTag(block, 'pubDate');
    const desc       = getTag(block, 'description') || getTag(block, 'content:encoded');
    const guid       = getTag(block, 'guid');
    const { artist, album, formatted } = parseTitle(rawTitle);

    return { rawTitle, artist, album, title: formatted, link, pubDate, desc, guid };
  });

  return items;
}

function buildXml(items) {
  const itemsXml = items.map(r => {
    const descParts = [
      r.artist
        ? `<strong>${esc(r.artist)} — ${esc(r.album)}</strong>`
        : `<strong>${esc(r.album)}</strong>`,
      r.desc ? `<p>${r.desc.replace(/<[^>]+>/g, '').slice(0, 300)}…</p>` : '',
      `<p><a href="${esc(r.link)}">Read full review on Pitchfork →</a></p>`,
    ].filter(Boolean).join('\n');

    return `
  <item>
    <title>${esc(r.title)}</title>
    <link>${esc(r.link)}</link>
    <guid isPermaLink="true">${esc(r.guid || r.link)}</guid>
    <pubDate>${r.pubDate}</pubDate>
    <description><![CDATA[${descParts}]]></description>
  </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Pitchfork — Album Reviews</title>
    <link>https://pitchfork.com/reviews/albums/</link>
    <description>Pitchfork album reviews, reformatted as Artist - Album</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>480</ttl>
    <atom:link href="https://pitchfork.com/reviews/albums/" rel="self" type="application/rss+xml"/>
    ${itemsXml}
  </channel>
</rss>`;
}

async function main() {
  await loadDeps();
  console.log(`Output : ${OUTPUT_FILE}`);
  console.log('─'.repeat(48));

  try {
    const items = await fetchAndReformat();
    const xml = buildXml(items);
    fs.writeFileSync(OUTPUT_FILE, xml, 'utf8');
    console.log(`[${timestamp()}] Wrote ${items.length} reviews → ${OUTPUT_FILE}`);
  } catch (err) {
    console.error(`[${timestamp()}] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
