#!/usr/bin/env node
/**
 * arcane-rss.js
 * Scrapes arcane.city for events occurring exactly one week from today,
 * and adds them as new RSS items (pubDate = now) to arcane-events.xml.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const FEED_FILE  = path.join(__dirname, 'arcane-events.xml');
const STATE_FILE = path.join(__dirname, 'arcane-state.json');
const BASE_URL   = 'https://arcane.city';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'arcane-rss-bot/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Zero-pad a number to width */
function pad(n, w = 2) { return String(n).padStart(w, '0'); }

/** Format a Date as YYYYMMDD */
function ymd(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Format a Date as RFC-822 for pubDate */
function rfc822(d) {
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]}, ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} +0000`;
}

/** Escape XML special characters */
function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

/** Very small HTML → plain-text strip */
function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse the event listing page for a given date (YYYYMMDD).
 * Returns array of { title, url, imageUrl, venue, time, price, tags }.
 */
function parseListingPage(html, targetDateStr) {
  const events = [];

  // Each event card starts with an <li> that contains an <img> and an <h3> with a link
  // We split on the event link pattern and reconstruct cards
  const cardPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = cardPattern.exec(html)) !== null) {
    const card = m[1];

    // Must contain an h3 with an event link
    const titleMatch = card.match(/<h3[^>]*>\s*<a[^>]+href="(https:\/\/arcane\.city\/events\/[^"]+)"[^>]*>([^<]+)<\/a>/);
    if (!titleMatch) continue;

    const url   = titleMatch[1];
    const title = titleMatch[2].trim();

    // Flyer image (first img in card)
    const imgMatch = card.match(/src="(https:\/\/arcane-city-library[^"]+(?<!tn-)[^"]*\.(?:webp|jpg|jpeg|png))"/);
    // Prefer non-thumbnail (no "tn-" prefix)
    const imgUrl = imgMatch ? imgMatch[1] : '';

    // Venue
    const venueMatch = card.match(/@ <a[^>]+>([^<]+)<\/a>/);
    const venue = venueMatch ? venueMatch[1].trim() : '';

    // Time
    const timeMatch = card.match(/(\d{1,2}:\d{2} (?:AM|PM))/);
    const time = timeMatch ? timeMatch[1] : '';

    // Price
    const priceMatch = card.match(/(\d+\.\d{2})/);
    const price = priceMatch ? `$${priceMatch[1]}` : '';

    // Tags
    const tagMatches = [...card.matchAll(/\/events\/tag\/[^"]+">([^<]+)<\/a>/g)];
    const tags = tagMatches.map(t => t[1].trim());

    events.push({ title, url, imageUrl: imgUrl, venue, time, price, tags });
  }

  return events;
}

/**
 * Fetch individual event page and extract description + flyer image.
 */
async function scrapeEventPage(url) {
  try {
    const html = await fetch(url);

    // og:description meta tag
    const ogDescMatch = html.match(/meta-og:description: ([^\n]+)/);
    const description = ogDescMatch ? ogDescMatch[1].trim() : '';

    // og:image (flyer)
    const ogImgMatch = html.match(/meta-og:image: ([^\n]+)/);
    const imageUrl = ogImgMatch ? ogImgMatch[1].trim() : '';

    // Body description paragraphs (between the h1 and the concert/entity info)
    const bodyMatch = html.match(/# [^\n]+\n[\s\S]*?\n\n([\s\S]+?)\n\[Concert|by \[/);
    const bodyText = bodyMatch ? stripHtml(bodyMatch[1]).replace(/\n+/g,' ').trim() : description;

    // Date/time line
    const dateLineMatch = html.match(/((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[^•\n]+)/);
    const dateLine = dateLineMatch ? dateLineMatch[1].trim() : '';

    // Venue from "@ Venue" pattern
    const venueMatch = html.match(/@ \[([^\]]+)\]/);
    const venue = venueMatch ? venueMatch[1] : '';

    // Age restriction
    const ageMatch = html.match(/(\d{2}\+|All Ages)/);
    const ageInfo = ageMatch ? ageMatch[1] : '';

    // Ticket link
    const ticketMatch = html.match(/\[Buy Tickets\]\((https:\/\/arcane\.city\/go\/[^)]+)\)/);
    const ticketUrl = ticketMatch ? ticketMatch[1] : '';

    // Tags
    const tagMatches = [...html.matchAll(/\/events\/tag\/[^"]+">([^<]+)<\/a>/g)];
    const tags = [...new Set(tagMatches.map(t => t[1].trim()))];

    return { description: bodyText || description, imageUrl, dateLine, venue, ageInfo, ticketUrl, tags };
  } catch (err) {
    console.warn(`  ⚠ Could not scrape ${url}: ${err.message}`);
    return {};
  }
}

// ─── RSS ─────────────────────────────────────────────────────────────────────

function buildDescription(event, details) {
  const img = details.imageUrl || event.imageUrl;
  const desc = details.description || '';
  const venue = details.venue || event.venue || '';
  const time  = event.time || '';
  const price = event.price ? `<p><strong>Price:</strong> ${esc(event.price)}</p>` : '';
  const age   = details.ageInfo ? `<p><strong>Age:</strong> ${esc(details.ageInfo)}</p>` : '';
  const ticket = details.ticketUrl
    ? `<p><a href="${esc(details.ticketUrl)}">🎟 Buy Tickets</a></p>` : '';
  const tagsHtml = (details.tags || event.tags || []).length
    ? `<p><em>Tags: ${esc((details.tags || event.tags).join(', '))}</em></p>` : '';
  const imgHtml = img
    ? `<p><img src="${esc(img)}" alt="${esc(event.title)}" style="max-width:600px;width:100%;" /></p>` : '';

  return [
    imgHtml,
    desc ? `<p>${esc(desc)}</p>` : '',
    `<p><strong>Venue:</strong> ${esc(venue)}</p>`,
    time  ? `<p><strong>Time:</strong> ${esc(time)}</p>` : '',
    price,
    age,
    ticket,
    tagsHtml,
    `<p><a href="${esc(event.url)}">View on Arcane City →</a></p>`,
  ].filter(Boolean).join('\n');
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { seen: [] }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadFeed() {
  if (!fs.existsSync(FEED_FILE)) return null;
  return fs.readFileSync(FEED_FILE, 'utf8');
}

function buildNewFeed(items) {
  const now = new Date();
  const itemsXml = items.map(i => `
  <item>
    <title>${esc(i.title)}</title>
    <link>${esc(i.url)}</link>
    <guid isPermaLink="true">${esc(i.url)}</guid>
    <pubDate>${i.pubDate}</pubDate>
    <description><![CDATA[${i.description}]]></description>
  </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Arcane City – Pittsburgh Events</title>
    <link>https://arcane.city</link>
    <description>Upcoming Pittsburgh events from arcane.city — one week ahead alerts.</description>
    <language>en-us</language>
    <lastBuildDate>${rfc822(now)}</lastBuildDate>
    <atom:link href="https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/arcane-events.xml" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`;
}

function injectItems(existingFeed, newItems) {
  if (!newItems.length) return existingFeed;
  const insertion = newItems.map(i => `
  <item>
    <title>${esc(i.title)}</title>
    <link>${esc(i.url)}</link>
    <guid isPermaLink="true">${esc(i.url)}</guid>
    <pubDate>${i.pubDate}</pubDate>
    <description><![CDATA[${i.description}]]></description>
  </item>`).join('\n');

  // Insert after <channel> opening tags (before first <item> or before </channel>)
  return existingFeed.replace(
    /(<lastBuildDate>[^<]*<\/lastBuildDate>)/,
    `<lastBuildDate>${rfc822(new Date())}</lastBuildDate>`
  ).replace(
    /(<item>|<\/channel>)/,
    `${insertion}\n  $1`
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const now      = new Date();
  const target   = new Date(now);
  target.setDate(target.getDate() + 7);
  const targetStr = ymd(target);         // e.g. "20260524"
  const targetUrl = `${BASE_URL}/events/upcoming/${targetStr}`;

  console.log(`🗓  Scraping events for ${targetStr} (one week from today)`);
  console.log(`    URL: ${targetUrl}`);

  const html = await fetch(targetUrl);

  const events = parseListingPage(html, targetStr);
  console.log(`📋 Found ${events.length} events on listing page`);

  if (!events.length) {
    console.log('✅ No events found one week from now. Feed unchanged.');
    return;
  }

  const state = loadState();
  const newEvents = events.filter(e => !state.seen.includes(e.url));
  console.log(`🆕 ${newEvents.length} new event(s) (not yet in feed)`);

  if (!newEvents.length) {
    console.log('✅ All events already in feed. Nothing to add.');
    return;
  }

  const pubDate = rfc822(now);
  const items   = [];

  for (const event of newEvents) {
    console.log(`  → Scraping: ${event.title}`);
    const details = await scrapeEventPage(event.url);

    // Format date for title: "Sat May 24 – Event Name"
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const titleDate = `${days[target.getDay()]} ${months[target.getMonth()]} ${target.getDate()}`;
    const fullTitle = `[${titleDate}] ${event.title}`;

    items.push({
      title:       fullTitle,
      url:         event.url,
      pubDate,
      description: buildDescription(event, details),
    });

    state.seen.push(event.url);

    // Polite delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  // Write feed
  const existingFeed = loadFeed();
  const updatedFeed  = existingFeed
    ? injectItems(existingFeed, items)
    : buildNewFeed(items);

  fs.writeFileSync(FEED_FILE, updatedFeed, 'utf8');
  saveState(state);

  console.log(`✅ Added ${items.length} item(s) to ${FEED_FILE}`);
  items.forEach(i => console.log(`   • ${i.title}`));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
