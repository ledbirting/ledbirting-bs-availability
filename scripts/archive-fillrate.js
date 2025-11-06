/**
 * Archive today's final fill-rate snapshot.
 * Output:
 *  logs/YYYY/MM/YYYY-MM-DD.json   (normalized snapshot)
 *  logs/YYYY/MM/YYYY-MM-DD.csv    (flat rows for analytics)
 *
 * Reykjavik is UTC, so "today" is UTC date.
 */

import fs from "node:fs";
import path from "node:path";

const urls = [
  process.env.SOURCE_URL_PRIMARY,
  process.env.SOURCE_URL_FALLBACK_1,
  process.env.SOURCE_URL_FALLBACK_2,
].filter(Boolean);

const now = new Date(); // UTC by default on runner
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
const dd = String(now.getUTCDate()).padStart(2, "0");
const dateISO = `${yyyy}-${mm}-${dd}`;

const outDir = path.join("logs", String(yyyy), String(mm));
const outJson = path.join(outDir, `${dateISO}.json`);
const outCsv  = path.join(outDir, `${dateISO}.csv`);

async function getJSON(urlList){
  const errs = [];
  for (const u of urlList){
    const url = `${u}?_=${Date.now()}`;
    try{
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    }catch(e){
      errs.push(`${u}: ${e.message}`);
    }
  }
  throw new Error("All sources failed: " + errs.join(" | "));
}

// Your live shape: { result: [ {date, rows:[{ du_name, fill_rate, ... }]} ] }
function normalize(raw){
  if (!raw || !Array.isArray(raw.result)) {
    throw new Error("Unsupported JSON shape, expected {result:[...]}");
  }
  const dates = [];
  const screensOrder = [];
  const seen = new Set();
  const map = {}; // screen -> date -> value

  for (const day of raw.result){
    const d = new Date(day.date);
    if (Number.isNaN(+d)) continue;
    const iso = d.toISOString().slice(0,10);
    dates.push(iso);

    for (const rec of (day.rows || [])){
      const name = String(rec?.du_name ?? "").trim();
      if (!name) continue;
      if (!seen.has(name)){ seen.add(name); screensOrder.push(name); }
      const v = Number(rec?.fill_rate);
      if (!Number.isNaN(v)){
        map[name] ||= {};
        map[name][iso] = v;
      }
    }
  }
  return { dates, screens: screensOrder, map, source_generated_at: raw.generated_at ?? null };
}

// Only keep the row for "today" in the archive file.
// If today's date isn't present yet in the feed, we still write what exists for today (likely nothing),
// so you can see the gap.
function snapshotForDate(norm, iso){
  const out = {};
  for (const s of norm.screens){
    const v = norm.map?.[s]?.[iso];
    if (typeof v === "number") {
      out[s] = v;
    }
  }
  return out;
}

function toCSVRows(iso, obj){
  // header: date,screen,fill_rate
  const rows = [["date","screen","fill_rate"]];
  const screens = Object.keys(obj).sort((a,b)=>a.localeCompare(b,'is'));
  for (const s of screens){
    rows.push([iso, s, String(obj[s])]);
  }
  return rows.map(r => r.map(field => {
    // basic CSV escaping
    if (/[",\n]/.test(field)) return `"${field.replace(/"/g,'""')}"`;
    return field;
  }).join(",")).join("\n");
}

async function main(){
  // If already archived for today, bail out (keeps idempotent on reruns)
  if (fs.existsSync(outJson)) {
    console.log(`Snapshot already exists: ${outJson}`);
    return;
  }

  const raw = await getJSON(urls);
  const norm = normalize(raw);
  const dataToday = snapshotForDate(norm, dateISO);

  // Ensure dirs
  fs.mkdirSync(outDir, { recursive: true });

  // Write JSON snapshot
  const payload = {
    date: dateISO,
    generated_at: norm.source_generated_at,
    count: Object.keys(dataToday).length,
    rows: Object.entries(dataToday).map(([screen, fill_rate]) => ({ screen, fill_rate })),
    meta: {
      note: "Values are 0..1 fill rates; >=0.934 considered 'sold out' by UI.",
      source_urls: urls,
      archived_at_utc: new Date().toISOString()
    }
  };
  fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${outJson}`);

  // Write CSV for quick diffing / ingestion
  const csv = toCSVRows(dateISO, dataToday);
  fs.writeFileSync(outCsv, csv + "\n", "utf8");
  console.log(`Wrote ${outCsv}`);
}

main().catch(err => {
  console.error("Archival failed:", err);
  process.exit(1);
});
