"use strict";

// Website source (design.md §5.2/§5.4): crawls the given URL's same-domain
// subtree, depth/limit-capped (both configurable per source, spec Assumptions
// "Website crawling scope"). Robots-disallowed / unreachable pages are
// skipped with a note rather than failing the whole crawl (FR-011 edge case:
// "partial index of already-crawled pages is retained").

const http = require("http");
const https = require("https");
const { extractLinks } = require("../extract/html");
const log = require("../log");

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_PAGE_LIMIT = 200;
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = "BrowserOS-KnowledgeBase/1.0 (+website source crawler)";

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" }, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        // Follow one hop of redirect — enough for the common http->https /
        // trailing-slash cases without building a full redirect loop guard.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchUrl(new URL(res.headers.location, targetUrl).toString()));
        }
        const contentType = res.headers["content-type"] || "";
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, contentType, body: Buffer.concat(chunks), finalUrl: targetUrl }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Timed out fetching ${targetUrl}`)));
    req.on("error", reject);
  });
}

/** Minimal robots.txt: collects `Disallow` prefixes under a matching
 *  `User-agent: *` (or our own agent name) group. Good enough for "respect
 *  robots.txt" without a full RFC 9309 parser. */
async function loadRobotsRules(origin) {
  try {
    const res = await fetchUrl(`${origin}/robots.txt`);
    if (res.status !== 200) return [];
    const lines = res.body.toString("utf8").split("\n");
    const disallow = [];
    let applies = false;
    for (const raw of lines) {
      const line = raw.replace(/#.*/, "").trim();
      if (!line) continue;
      const [rawKey, ...rest] = line.split(":");
      const key = rawKey.trim().toLowerCase();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        applies = value === "*" || /knowledgebase/i.test(value);
      } else if (key === "disallow" && applies && value) {
        disallow.push(value);
      }
    }
    return disallow;
  } catch (err) {
    // No robots.txt, or unreachable — treat as "everything allowed."
    log.debug(`robots.txt fetch for ${origin} failed — treating as everything allowed`, err && err.message);
    return [];
  }
}

function isDisallowed(pathname, rules) {
  return rules.some((rule) => pathname.startsWith(rule));
}

/** Crawls `source.reference` (a URL) up to `maxDepth` link-hops / `pageLimit`
 *  total pages within the same hostname. Returns the extracted page items
 *  plus crawl notes (robots/unreachable skips) for the Health tab. */
async function acquire(source, opts) {
  const onProgress = (opts && opts.onProgress) || (() => {});
  const startUrl = source.reference;
  const origin = new URL(startUrl).origin;
  const hostname = new URL(startUrl).hostname;
  const maxDepth = (source.extra && source.extra.maxDepth) || DEFAULT_MAX_DEPTH;
  const pageLimit = (source.extra && source.extra.pageLimit) || DEFAULT_PAGE_LIMIT;

  const robotsRules = await loadRobotsRules(origin);

  const visited = new Set();
  const queue = [{ url: startUrl, depth: 0 }];
  const items = [];
  const notes = [];

  while (queue.length > 0 && items.length < pageLimit) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      log.debug(`skipping malformed queued URL "${url}"`, err && err.message);
      continue;
    }
    if (isDisallowed(parsed.pathname, robotsRules)) {
      notes.push({ url, reason: "robots-disallowed" });
      continue;
    }

    let res;
    try {
      res = await fetchUrl(url);
    } catch (err) {
      log.warn(`crawl: unreachable page ${url}`, err && err.message);
      notes.push({ url, reason: `unreachable: ${err.message}` });
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      notes.push({ url, reason: `HTTP ${res.status}` });
      continue;
    }
    if (!/text\/html/.test(res.contentType)) {
      notes.push({ url, reason: `skipped non-HTML content-type: ${res.contentType || "unknown"}` });
      continue;
    }

    items.push({
      name: parsed.pathname === "/" || parsed.pathname === "" ? parsed.hostname : parsed.pathname,
      bytes: res.body,
      referenceTime: new Date().toISOString(),
      sourceRef: url,
    });
    onProgress({ done: items.length, total: pageLimit });

    if (depth < maxDepth) {
      for (const link of extractLinks(res.body, url)) {
        let linkHost;
        try {
          linkHost = new URL(link).hostname;
        } catch (err) {
          log.debug(`skipping malformed discovered link "${link}"`, err && err.message);
          continue;
        }
        if (linkHost === hostname && !visited.has(link)) {
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  log.debug(`crawl of ${startUrl} finished`, { pagesVisited: visited.size, items: items.length, notes: notes.length });
  return { items, notes, pagesVisited: visited.size };
}

module.exports = { acquire, DEFAULT_MAX_DEPTH, DEFAULT_PAGE_LIMIT };
