// generate.mjs
import fs from "fs";
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

// IDs and names (cached to avoid API lookups)
const screens = [
  { id: 237870, name: "Akureyri #1" },
  { id: 338148, name: "Akureyri #2" },
  { id: 404813, name: "Austurstræti" },
  { id: 406591, name: "Borgartún" },
  { id: 237865, name: "Breiðholt #1" },
  { id: 237046, name: "Breiðholt #2" },
  { id: 235464, name: "Egilshöll #1" },
  { id: 237866, name: "Egilshöll #2" },
  { id: 441742, name: "Einhella" },
  { id: 456840, name: "Fjarðarhraun" },
  { id: 321889, name: "Frumherji - Reykjanesbær" },
  { id: 321888, name: "Frumherji - Selfoss" },
  { id: 569050, name: "Glerártorg #1" },
  { id: 569051, name: "Glerártorg #2" },
  { id: 237871, name: "Grandi" },
  { id: 237892, name: "Hæðasmári #1" },
  { id: 331110, name: "Hæðasmári Standur - Portrait" },
  { id: 527246, name: "Hafnartorg #1 Inngangur" },
  { id: 527245, name: "Hafnartorg #2 Lengja" },
  { id: 527247, name: "Hafnartorg #3 Greiðsluvél" },
  { id: 527254, name: "Hafnartorg #4 Kubbur" },
  { id: 438452, name: "Hagasmári" },
  { id: 235466, name: "Höfðabakki #1" },
  { id: 235465, name: "Höfðabakki #2" },
  { id: 235463, name: "Kaplakriki #1" },
  { id: 237864, name: "Kaplakriki #2" },
  { id: 319979, name: "Kaplakriki #3" },
  { id: 408992, name: "Litlatún #1" },
  { id: 480851, name: "Lyfjaval - Suðurfell" },
  { id: 331111, name: "Lyfjaval - Vesturlandsvegur" },
  { id: 251695, name: "Njarðarbraut #1" },
  { id: 237872, name: "Njarðarbraut #2" },
  { id: 237874, name: "Sæbraut - Holtagarðar" },
  { id: 405768, name: "Sæbraut - Sundaborg" },
  { id: 237868, name: "Selfoss #1" },
  { id: 237869, name: "Selfoss #2" },
  { id: 445022, name: "Smáratorg #1" },
  { id: 445023, name: "Smáratorg #2" },
  { id: 445024, name: "Vatnsendahvarf #1" },
  { id: 490445, name: "Vestmannaeyjar" },
  { id: 235462, name: "Vesturlandsvegur #1" },
  { id: 237863, name: "Vesturlandsvegur #2" }
];

let sessionCookie = null;

// ---------- LOGIN ----------
async function login() {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASS)}`
  });

  const cookies = res.headers.raw()["set-cookie"];
  const sess = cookies?.find(c => /^session=/i.test(c))?.split(";")[0];
  if (!sess) throw new Error(`Login failed (${res.status})`);
  sessionCookie = sess;
  console.log("✅ Logged in successfully");
}

// ---------- FETCH WRAPPER ----------
async function direct(path, options = {}, retried = false) {
  if (!sessionCookie) await login();
  const res = await fetch(`${BASE}${path}`, {
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
    return direct(path, options, true);
  }
  return res.json();
}

// ---------- HELPERS ----------
function buildPayload(date, screenId) {
  return {
    start_date: date,
    end_date: date,
    start_time: "00:00:00",
    end_time: "23:59:59",
    time_interval: "day",
    inventory_type: "digital",
    screen_ids: [screenId]
  };
}

function extractItems(resp) {
  if (Array.isArray(resp?.data?.proposal_items)) return resp.data.proposal_items;
  if (Array.isArray(resp?.proposal_items)) return resp.proposal_items;
  return [];
}

async function getFillForScreen(screenId, date) {
  const payload = buildPayload(date, screenId);
  const resp = await direct("/api/v1/reporting/fill_rate_breakdown", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const items = extractItems(resp);
  const fill = Math.min(1, Math.max(0, items.reduce((a, b) => a + (Number(b.fill_pressure) || 0), 0)));
  return { screenId, fill, count: items.length };
}

// ---------- MAIN ----------
async function main() {
  const today = new Date();
  const allDays = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const result = [];
  for (const date of allDays) {
    const rows = [];
    for (const s of screens) {
      try {
        const { fill, count } = await getFillForScreen(s.id, date);
        rows.push({ id: s.id, du_name: s.name, fill_rate: fill, rows_seen: count });
        console.log(`→ ${date} ${s.name}: ${fill.toFixed(3)} (${count} items)`);
      } catch (e) {
        rows.push({ id: s.id, du_name: s.name, fill_rate: 0, error: e.message });
        console.warn(`❌ ${s.name}: ${e.message}`);
      }
    }
    result.push({ date, count: rows.length, rows });
  }

  const outPath = "public/fillrate-next30.json";
  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), result }, null, 2));
  console.log(`✅ Wrote ${outPath}`);
}

main().catch(e => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});
