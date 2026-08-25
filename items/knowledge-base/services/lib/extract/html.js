"use strict";

const cheerio = require("cheerio");
const log = require("../log");

// Extracts readable text from an HTML page — strips nav/script/style/noscript
// so a crawled page's episode body is the article content, not chrome (used
// for website sources, design.md §5.4).
async function extractHtml(buffer) {
  const html = buffer.toString("utf8");
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, header, svg").remove();
  const title = $("title").first().text().trim();
  const body = $("body").text().replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  return title ? `${title}\n\n${body}` : body;
}

/** Same-domain link discovery for the website crawler — absolute hrefs only,
 *  resolved against the page's own URL. */
function extractLinks(buffer, pageUrl) {
  const html = buffer.toString("utf8");
  const $ = cheerio.load(html);
  const links = new Set();
  let malformed = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const resolved = new URL(href, pageUrl);
      resolved.hash = "";
      if (resolved.protocol === "http:" || resolved.protocol === "https:") links.add(resolved.toString());
    } catch {
      malformed++;
    }
  });
  if (malformed > 0) log.debug(`${pageUrl}: skipped ${malformed} malformed href(s)`);
  return Array.from(links);
}

module.exports = { extractHtml, extractLinks };
