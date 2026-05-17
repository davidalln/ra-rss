#!/usr/bin/env node

/**
 * Pitchfork Album Reviews RSS Generator
 *
 * Fetches Pitchfork's official RSS feed to get review URLs, then scrapes
 * each review page's <meta> tags to get artist, album, artwork, and description.
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

const OUTPUT_FILE = path.resolve(process.env.OUTPUT_FILE || './pitchfork-album-reviews.xml');
const DELAY_MS    = parseInt(process.env.DELAY_MS) || 500;

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function getMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']` +
    `|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
    'i'
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || '').trim() : '';
}

// Decode common HTML entities
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RSS-scraper/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    timeout: 15000,
  });
  if (!res.ok) return null;
  return res.text();
}

async function getReviewUrls() {
  console.log(`[${timestamp()}] Fetching Pitchfork RSS for URLs…`);
  const html = await fetchPage(FEED_URL);
  if (!html) throw new Error('Failed to fetch Pitchfork RSS feed');

  const itemBlocks = html.match(/<item>[\s\S]*?<\/item>/gi) || [];
  if (!itemBlocks.length) throw new Error('No items found in feed');

  return itemBlocks.map(block => {
    const link    = getTag(block, 'link') || getTag(block, 'guid');
    const pubDate = getTag(block, 'pubDate');
    return { link, pubDate };
  }).filter(item => item.link);
}

async function scrapeReviewPage({ link, pubDate }) {
  const html = await fetchPage(link);
  if (!html) return null;

  const ogTitle = decodeEntities(getMeta(html, 'og:title'));
  if (!ogTitle) return null;

  // og:title is "Artist: Album"
  const colonIdx = ogTitle.indexOf(': ');
  let artist, album;
  if (colonIdx !== -1) {
    artist = ogTitle.slice(0, colonIdx).trim();
    album  = ogTitle.slice(colonIdx + 2).trim();
  } else {
    artist = '';
    album  = ogTitle;
  }

  const image       = getMeta(html, 'og:image');
  const description = decodeEntities(getMeta(html, 'description') || getMeta(html, 'og:description'));

  return { artist, album, image, description, link, pubDate };
}

function buildXml(items) {
  const itemsXml = items.map(r => {
    const title = r.artist ? `${esc(r.artist)} – ${esc(r.album)}` : esc(r.album);

	const descParts = [
		r.description ? `<p>${esc(r.description)}</p>` : '',
		r.image ? `<img src="${r.image}" alt="${esc(r.album)} cover"/>` : '',
	].filter(Boolean).join('\n');

    return `
  <item>
    <title>${title}</title>
    <link>${esc(r.link)}</link>
    <guid isPermaLink="true">${esc(r.link)}</guid>
    <pubDate>${r.pubDate}</pubDate>
    ${r.image ? `<enclosure url="${esc(r.image)}" type="image/jpeg" length="0"/>` : ''}
    <description><![CDATA[${descParts}${r.image ? `\n<img src="${r.image}" alt="${esc(r.album)} cover"/>` : ''}]]></description>
  </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Pitchfork — Album Reviews</title>
    <link>https://pitchfork.com/reviews/albums/</link>
    <description>Pitchfork album reviews with artist, album art, and description</description>
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
    const reviewUrls = await getReviewUrls();
    console.log(`[${timestamp()}] Found ${reviewUrls.length} reviews to scrape…`);

    const items = [];
    for (const item of reviewUrls) {
      process.stdout.write(`  ${item.link} … `);
      try {
        const review = await scrapeReviewPage(item);
        if (review) {
          items.push(review);
          process.stdout.write(`✓ ${review.artist} – ${review.album}\n`);
        } else {
          process.stdout.write('(skipped)\n');
        }
      } catch (e) {
        process.stdout.write(`ERROR: ${e.message}\n`);
      }
      await sleep(DELAY_MS);
    }

    if (!items.length) throw new Error('No reviews scraped');

    const xml = buildXml(items);
    fs.writeFileSync(OUTPUT_FILE, xml, 'utf8');
    console.log(`[${timestamp()}] Wrote ${items.length} reviews → ${OUTPUT_FILE}`);
  } catch (err) {
    console.error(`[${timestamp()}] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
