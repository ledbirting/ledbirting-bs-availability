import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const BASE = process.env.BROADSIGN_BASE;
const EMAIL = process.env.BROADSIGN_EMAIL;
const PASS = process.env.BROADSIGN_PASSWORD;

if (!BASE || !EMAIL || !PASS) {
  console.error("Missing environment variables. Check BROADSIGN_BASE, BROADSIGN_EMAIL, BROADSIGN_PASSWORD.");
  process.exit(1);
}

// Keep this list in sync with the screens used for fill-rate generation.
const SCREEN_IDS = [
  237870, 338148, 404813, 406591, 237865, 237046, 235464, 237866, 441742, 456840,
  321889, 321888, 569050, 569051, 237871, 237892, 331110, 527246, 527245, 527247,
  527254, 438452, 235466, 235465, 235463, 237864, 319979, 408992, 480851, 331111,
  251695, 237872, 237874, 405768, 237868, 237869, 445022, 445023, 445024, 490445,
  235462, 237863
];

const REPORT_FROM_TODAY_ONLY = String(process.env.LINE_ITEMS_REPORT_FROM_TODAY_ONLY || "true").toLowerCase() !== "false";
const FAR_FUTURE_END_DATE = process.env.LINE_ITEMS_FAR_FUTURE_END_DATE || "2099-12-31";
const RANGE_CHUNK_DAYS = parseEnvInt("LINE_ITEMS_RANGE_CHUNK_DAYS", 30);
const EMPTY_CHUNK_STOP_AFTER = parseEnvInt("LINE_ITEMS_EMPTY_CHUNK_STOP_AFTER", 6);
const MAX_RANGE_CHUNKS = parseEnvInt("LINE_ITEMS_MAX_RANGE_CHUNKS", 48);
const SCREEN_BATCH_SIZE = parseEnvInt("LINE_ITEMS_SCREEN_BATCH_SIZE", 12);
const PAGE_SIZE = parseEnvInt("LINE_ITEMS_PAGE_SIZE", 300);
const MAX_PAGES_PER_QUERY = parseEnvInt("LINE_ITEMS_MAX_PAGES_PER_QUERY", 3);
const MAX_ITEMS_PER_RUN = parseEnvInt("LINE_ITEMS_MAX_ITEMS_PER_RUN", 20000);
const OUT_PATH = process.env.LINE_ITEMS_OUTPUT_PATH || "public/campaign-line-items.json";

let sessionCookie = null;

function parseEnvInt(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return fallback;
}

function dateISO(inputDate) {
  return inputDate.toISOString().slice(0, 10);
}

function buildDateRange() {
  const today = new Date();
  const startDate = dateISO(today);
  const endDate = FAR_FUTURE_END_DATE;
  return { startDate, endDate };
}

function addDaysToIso(isoDate, daysToAdd) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  return dateISO(d);
}

function minIso(a, b) {
  return a <= b ? a : b;
}

function buildChunkedRanges(startDate, endDate, chunkDays, maxChunks) {
  const ranges = [];
  let cursor = startDate;
  for (let i = 0; i < maxChunks && cursor <= endDate; i += 1) {
    const chunkEnd = minIso(addDaysToIso(cursor, chunkDays - 1), endDate);
    ranges.push({ startDate: cursor, endDate: chunkEnd });
    cursor = addDaysToIso(chunkEnd, 1);
  }
  return ranges;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) {
    out.push(array.slice(i, i + size));
  }
  return out;
}

async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASS)}`
  });

  const cookies = res.headers.raw()["set-cookie"];
  const sess = cookies?.find((c) => /^session=/i.test(c))?.split(";")[0];
  if (!sess) throw new Error(`Login failed (${res.status})`);
  sessionCookie = sess;
}

async function direct(apiPath, options = {}, retried = false) {
  if (!sessionCookie) await login();

  const res = await fetch(`${BASE}${apiPath}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
      ...(options.headers || {})
    }
  });

  if (res.status === 401 && !retried) {
    sessionCookie = null;
    await login();
    return direct(apiPath, options, true);
  }

  return res.json();
}

function extractItems(resp) {
  if (Array.isArray(resp?.data?.proposal_items)) return resp.data.proposal_items;
  if (Array.isArray(resp?.proposal_items)) return resp.proposal_items;
  return [];
}

async function fetchProposalItems(range, screenIds, counters) {
  const all = [];
  let skip = 0;

  for (let page = 0; page < MAX_PAGES_PER_QUERY; page += 1) {
    if (counters.totalItemsSeen >= MAX_ITEMS_PER_RUN) {
      counters.hitLimit = true;
      break;
    }

    const payload = {
      start_date: range.startDate,
      end_date: range.endDate,
      start_time: "00:00:00",
      end_time: "23:59:59",
      time_interval: "day",
      inventory_type: "digital",
      screen_ids: screenIds,
      $top: PAGE_SIZE,
      $skip: skip,
      sort: { field: "start_date", dir: "asc" }
    };

    counters.apiCalls += 1;
    const resp = await direct("/api/v1/reporting/fill_rate_breakdown", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const items = extractItems(resp);
    if (!items.length) break;

    all.push(...items);
    counters.totalItemsSeen += items.length;

    if (items.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  return all;
}

function normalizePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isNotExpired(item, todayIso) {
  const endDate = String(item?.end_date || "").slice(0, 10);
  if (!endDate) return true;
  return endDate >= todayIso;
}

function makeKey(campaignName, lineItemName, price) {
  return `${campaignName}\u001f${lineItemName}\u001f${price === null ? "null" : String(price)}`;
}

async function main() {
  const todayIso = dateISO(new Date());
  const globalRange = buildDateRange();
  const ranges = buildChunkedRanges(
    globalRange.startDate,
    globalRange.endDate,
    RANGE_CHUNK_DAYS,
    MAX_RANGE_CHUNKS
  );
  const screenChunks = chunk(SCREEN_IDS, SCREEN_BATCH_SIZE);
  const counters = {
    apiCalls: 0,
    totalItemsSeen: 0,
    hitLimit: false,
    rangeChunksProcessed: 0,
    stoppedOnEmptyRanges: false,
    maxRangeChunksReached: false
  };
  const map = new Map();
  let consecutiveEmptyRanges = 0;

  for (const range of ranges) {
    counters.rangeChunksProcessed += 1;
    let rangeItemCount = 0;

    for (const group of screenChunks) {
      const items = await fetchProposalItems(range, group, counters);
      rangeItemCount += items.length;

      for (const item of items) {
        if (REPORT_FROM_TODAY_ONLY && !isNotExpired(item, todayIso)) continue;

        const campaignName = String(item?.campaign_name || "").trim() || "Unknown campaign";
        const lineItemName = String(item?.line_name || "").trim() || "Unnamed line item";
        const price = normalizePrice(item?.price);
        const startDate = String(item?.start_date || "").slice(0, 10) || null;
        const endDate = String(item?.end_date || "").slice(0, 10) || null;
        const key = makeKey(campaignName, lineItemName, price);

        let entry = map.get(key);
        if (!entry) {
          entry = {
            campaign_name: campaignName,
            line_item_name: lineItemName,
            price,
            start_date: startDate,
            end_date: endDate,
            seen_count: 0
          };
          map.set(key, entry);
        } else {
          if (startDate && (!entry.start_date || startDate < entry.start_date)) entry.start_date = startDate;
          if (endDate && (!entry.end_date || endDate > entry.end_date)) entry.end_date = endDate;
        }

        entry.seen_count += 1;
      }

      if (counters.hitLimit) break;
    }

    if (rangeItemCount === 0) {
      consecutiveEmptyRanges += 1;
      if (consecutiveEmptyRanges >= EMPTY_CHUNK_STOP_AFTER) {
        counters.stoppedOnEmptyRanges = true;
        break;
      }
    } else {
      consecutiveEmptyRanges = 0;
    }

    if (counters.hitLimit) break;
  }

  if (!counters.hitLimit && !counters.stoppedOnEmptyRanges && counters.rangeChunksProcessed >= MAX_RANGE_CHUNKS) {
    counters.maxRangeChunksReached = true;
  }

  const rows = Array.from(map.values()).sort((a, b) =>
    a.campaign_name.localeCompare(b.campaign_name) ||
    a.line_item_name.localeCompare(b.line_item_name)
  );

  const out = {
    generated_at: new Date().toISOString(),
    scope: {
      report_start_date: globalRange.startDate,
      report_end_date: globalRange.endDate,
      include_from_today_only: REPORT_FROM_TODAY_ONLY
    },
    optimization: {
      rule: "Query chunked date ranges from today onward, stop after consecutive empty chunks, and enforce paging/item caps.",
      range_chunk_days: RANGE_CHUNK_DAYS,
      empty_chunk_stop_after: EMPTY_CHUNK_STOP_AFTER,
      max_range_chunks: MAX_RANGE_CHUNKS,
      screen_batch_size: SCREEN_BATCH_SIZE,
      page_size: PAGE_SIZE,
      max_pages_per_query: MAX_PAGES_PER_QUERY,
      max_items_per_run: MAX_ITEMS_PER_RUN,
      truncated: counters.hitLimit || counters.maxRangeChunksReached || counters.stoppedOnEmptyRanges
    },
    stats: {
      api_calls: counters.apiCalls,
      items_seen: counters.totalItemsSeen,
      unique_items: rows.length,
      range_chunks_processed: counters.rangeChunksProcessed,
      stopped_on_empty_ranges: counters.stoppedOnEmptyRanges,
      max_range_chunks_reached: counters.maxRangeChunksReached
    },
    items: rows
  };

  const absOut = path.resolve(OUT_PATH);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, JSON.stringify(out, null, 2), "utf8");
  console.log(`Wrote ${OUT_PATH} with ${rows.length} unique campaign line-items.`);
}

main().catch((err) => {
  console.error("Line-item sync failed:", err);
  process.exit(1);
});
