#!/usr/bin/env node

/**
 * RA Album Reviews RSS Generator
 *
 * RA's listing page is JS-rendered so plain HTTP scraping gets nothing.
 * Instead this script:
 *   1. Reads the latest known review ID from a state file (or starts from
 *      a hardcoded baseline).
 *   2. Probes upward from that ID to find any new reviews published since
 *      the last run.
 *   3. Parses each review page's <meta> tags (which ARE server-rendered).
 *   4. Writes ra-album-reviews.xml and repeats on INTERVAL_MINUTES.
 *
 * Usage:
 *   npm install node-fetch
 *   node ra-rss.js
 *
 * Optional env vars:
 *   INTERVAL_MINUTES=10        Poll frequency (default: 10)
 *   OUTPUT_FILE=./feed.xml     Path for the RSS file (default: ./ra-album-reviews.xml)
 *   STATE_FILE=./ra-state.json Path for persisted state (default: ./ra-state.json)
 *   BACKFILL=30                How many recent reviews to collect on first run (default: 30)
 *   DELAY_MS=800               Milliseconds between requests (default: 800)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_FILE  = path.resolve(process.env.OUTPUT_FILE  || './ra-album-reviews.xml');
const STATE_FILE   = path.resolve(process.env.STATE_FILE   || './ra-state.json');
const BACKFILL     = parseInt(process.env.BACKFILL)        || 30;
const DELAY_MS     = parseInt(process.env.DELAY_MS)        || 800;

// Highest known review ID as of May 2026
const BASELINE_ID  = 36353;

let fetch;

async function loadDeps() {
  try {
    fetch = (await import('node-fetch')).default;
  } catch {
    console.error('Missing dependency: run  npm install node-fetch');
    process.exit(1);
  }
}

// ─── state ───────────────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { latestId: null, reviews: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ─── fetching ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function fetchPage(id) {
  const url = `https://ra.co/reviews/${id}`;
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

// ─── parsing ─────────────────────────────────────────────────────────────────

function getMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']` +
    `|<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
    'i'
  );
  const m = html.match(re);
  return m ? (m[1] || m[2] || '').trim() : '';
}

function parseReview(html, id) {
  const ogTitle = getMeta(html, 'og:title');
  if (!ogTitle || !ogTitle.includes('Review')) return null;

  // Determine type
  const isAlbum  = /album\s+review/i.test(ogTitle);
  const isSingle = /single\s+review/i.test(ogTitle);
  const isEP     = /\bep\s+review/i.test(ogTitle);
  if (!isAlbum && !isSingle && !isEP) return null;

  // "Artist - Release · Album Review ⟋ RA"
  const titlePart = ogTitle.replace(/\s*·.*$/, '').trim();
  let artist = '', release = '';
  const dash = titlePart.indexOf(' - ');
  if (dash !== -1) {
    artist  = titlePart.slice(0, dash).trim();
    release = titlePart.slice(dash + 3).trim();
  } else {
    release = titlePart;
  }

  const description = getMeta(html, 'og:description') || getMeta(html, 'description') || '';
  const image       = getMeta(html, 'og:image') || '';
  const url         = `https://ra.co/reviews/${id}`;

  // Published date
  const dateMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/)
    || html.match(/(\d{4}-\d{2}-\d{2})/);
  const pubDate = dateMatch
    ? new Date(dateMatch[1]).toUTCString()
    : new Date().toUTCString();

  // Label link
  const labelMatch = html.match(/\/labels\/\d+[^>]*>([^<]+)<\/a>/);
  const label = labelMatch ? labelMatch[1].trim() : '';

  // Genre link
  const genreMatch = html.match(/\/reviews\/(?:albums|singles)\?genre=[^"'>]+[^>]*>([^<]+)<\/a>/);
  const genre = genreMatch ? genreMatch[1].trim() : '';

  const type = isAlbum ? 'Album' : isEP ? 'EP' : 'Single';

  return { id, url, artist, release, type, description, image, label, genre, pubDate };
}

// ─── RSS builder ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildXml(reviews) {
  const items = reviews.map(r => {
    const title = r.artist
      ? `${esc(r.artist)} – ${esc(r.release)} [${r.type}]`
      : `${esc(r.release)} [${r.type}]`;

    const descParts = [
      r.description ? `<p>${esc(r.description)}</p>` : '',
      r.label  ? `<p>Label: ${esc(r.label)}</p>`  : '',
      r.genre  ? `<p>Genre: ${esc(r.genre)}</p>`  : '',
    ].filter(Boolean).join('\n');

    return `
  <item>
    <title>${title}</title>
    <link>${esc(r.url)}</link>
    <guid isPermaLink="true">${esc(r.url)}</guid>
    <pubDate>${r.pubDate}</pubDate>
    ${r.label ? `<category><![CDATA[${r.label}]]></category>` : ''}
    ${r.genre ? `<category><![CDATA[${r.genre}]]></category>` : ''}
    ${r.image ? `<enclosure url="${esc(r.image)}" type="image/jpeg" length="0"/>` : ''}
    <description><![CDATA[${descParts}]]></description>
  </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Resident Advisor — Reviews</title>
    <link>https://ra.co/reviews</link>
    <description>Latest album, EP and single reviews from Resident Advisor</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <ttl>10</ttl>
    <atom:link href="https://ra.co/reviews" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}

// ─── main loop ───────────────────────────────────────────────────────────────

async function run() {
  const state = loadState();
  let reviews = state.reviews || [];

  if (!state.latestId) {
    // First run: walk backwards from baseline to collect BACKFILL reviews
    console.log(`[${timestamp()}] First run — backfilling ${BACKFILL} reviews from ID ${BASELINE_ID}`);
    let id = BASELINE_ID;
    let collected = 0;
    let misses = 0;

    while (collected < BACKFILL && misses < 20) {
      process.stdout.write(`  ID ${id} … `);
      try {
        const html = await fetchPage(id);
        if (html) {
          const review = parseReview(html, id);
          if (review) {
            reviews.unshift(review);
            collected++;
            misses = 0;
            process.stdout.write(`✓ ${review.artist} - ${review.release}\n`);
          } else {
            process.stdout.write('(not a review)\n');
            misses++;
          }
        } else {
          process.stdout.write('(404)\n');
          misses++;
        }
      } catch (e) {
        process.stdout.write(`ERROR: ${e.message}\n`);
      }
      id--;
      await sleep(DELAY_MS);
    }

    state.latestId = BASELINE_ID;

  } else {
    // Subsequent runs: walk upward from last known ID
    console.log(`[${timestamp()}] Checking for new reviews above ID ${state.latestId}`);
    let id = state.latestId + 1;
    let misses = 0;
    const newReviews = [];

    while (misses < 10) {
      process.stdout.write(`  ID ${id} … `);
      try {
        const html = await fetchPage(id);
        if (html) {
          const review = parseReview(html, id);
          if (review) {
            newReviews.push(review);
            state.latestId = id;
            misses = 0;
            process.stdout.write(`✓ ${review.artist} - ${review.release}\n`);
          } else {
            process.stdout.write('(not a review)\n');
            misses++;
          }
        } else {
          process.stdout.write('(404)\n');
          misses++;
        }
      } catch (e) {
        process.stdout.write(`ERROR: ${e.message}\n`);
      }
      id++;
      await sleep(DELAY_MS);
    }

    if (newReviews.length) {
      reviews = [...newReviews, ...reviews].slice(0, 100);
      console.log(`[${timestamp()}] Found ${newReviews.length} new review(s)`);
    } else {
      console.log(`[${timestamp()}] No new reviews found`);
    }
  }

  reviews.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  state.reviews = reviews.slice(0, 100);
  saveState(state);

  if (reviews.length) {
    const xml = buildXml(reviews);
    fs.writeFileSync(OUTPUT_FILE, xml, 'utf8');
    console.log(`[${timestamp()}] Wrote ${reviews.length} reviews → ${OUTPUT_FILE}`);
  } else {
    console.warn(`[${timestamp()}] No reviews to write yet`);
  }
}

async function main() {
  await loadDeps();
  console.log('RA Reviews RSS Generator');
  console.log(`Output    : ${OUTPUT_FILE}`);
  console.log(`State     : ${STATE_FILE}`);
  console.log(`Backfill  : ${BACKFILL} reviews on first run`);
  console.log('─'.repeat(48));

  await run();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
