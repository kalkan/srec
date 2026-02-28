import * as satellite from "https://cdn.jsdelivr.net/npm/satellite.js@5.0.1/dist/satellite.es.js";

const NORAD_ID = 63229;
const LOCAL_TLE_URL = "./tle.txt"; // same-origin => no CORS

// ===== Map
const map = L.map("map", { worldCopyJump: true }).setView([39, 35], 3);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const nowMarker = L.circleMarker([0, 0], { radius: 6 }).addTo(map);
let trackLine = L.polyline([], { weight: 2 }).addTo(map);

// ===== UI
const dtEl = document.getElementById("dt");
const hoursEl = document.getElementById("hours");
const statusEl = document.getElementById("status");
const btnDraw = document.getElementById("draw");
const btnLive = document.getElementById("live");
const btnStop = document.getElementById("stop");

const olatEl = document.getElementById("olat");
const olonEl = document.getElementById("olon");
const oaltEl = document.getElementById("oalt");
const npassesEl = document.getElementById("npasses");
const searchHoursEl = document.getElementById("searchHours");
const btnCalcPasses = document.getElementById("calcPasses");
const passesWrap = document.getElementById("passesWrap");

// datetime-local default now
function pad(n) { return String(n).padStart(2, "0"); }
function toLocalInputValue(d) {
  const yy = d.getFullYear(), mm = pad(d.getMonth() + 1), dd = pad(d.getDate());
  const hh = pad(d.getHours()), mi = pad(d.getMinutes());
  return `${yy}-${mm}-${dd}T${hh}:${mi}`;
}
dtEl.value = toLocalInputValue(new Date());

// ===== TLE
async function fetchLocalTLE() {
  statusEl.textContent = "TLE okunuyor (tle.txt)…";
  const res = await fetch(LOCAL_TLE_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`tle.txt okunamadı (HTTP ${res.status})`);
  const txt = (await res.text()).trim();
  const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // Expect 3 lines: NAME + L1 + L2
  if (lines.length < 3) throw new Error("tle.txt beklenen formatta değil (3 satır yok).");
  const name = lines[0];
  const l1 = lines[1];
  const l2 = lines[2];
  return { name, l1, l2 };
}

// ===== Helpers
function normalizeLon(lon) {
  let x = lon;
  if (x > 180) x -= 360;
  if (x < -180) x += 360;
  return x;
}

function eciGeodeticFromSatrec(satrec, date) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position) return null;
  const gmst = satellite.gstime(date);
  const gd = satellite.eciToGeodetic(pv.position, gmst);
  return {
    lat: satellite.degreesLat(gd.latitude),
    lon: normalizeLon(satellite.degreesLong(gd.longitude)),
    altKm: gd.height,
  };
}

function setMarkerPopup(name, date, lat, lon, altKm) {
  nowMarker.setLatLng([lat, lon]);
  nowMarker.bindPopup(
    `<b>${name}</b><br>` +
    `${date.toISOString()}<br>` +
    `Lat: ${lat.toFixed(4)}°, Lon: ${lon.toFixed(4)}°<br>` +
    `Alt: ${altKm.toFixed(1)} km`
  );
}

function groundTrackPoints(satrec, startDate, hoursForward) {
  const pts = [];
  const stepSec = 30;
  const totalSec = hoursForward * 3600;

  for (let t = 0; t <= totalSec; t += stepSec) {
    const d = new Date(startDate.getTime() + t * 1000);
    const gd = eciGeodeticFromSatrec(satrec, d);
    if (!gd) continue;
    pts.push({ ...gd, date: d });
  }
  return pts;
}

// ===== Pass prediction (AOS/LOS)
// We compute elevation at observer via satellite.js topocentric frame.
function elevationDeg(satrec, date, obsLatDeg, obsLonDeg, obsAltM) {
  const pv = satellite.propagate(satrec, date);
  if (!pv.position) return null;

  const gmst = satellite.gstime(date);
  const satEcf = satellite.eciToEcf(pv.position, gmst);

  const observerGd = {
    latitude: satellite.degreesToRadians(obsLatDeg),
    longitude: satellite.degreesToRadians(obsLonDeg),
    height: obsAltM / 1000.0,
  };
  const obsEcf = satellite.geodeticToEcf(observerGd);
  const topo = satellite.topocentric(observerGd, satellite.ecfToLookAngles(observerGd, satEcf).rangeSat ? satEcf : satEcf); // safe

  // satellite.js provides ecfToLookAngles which returns elevation/azimuth directly:
  const look = satellite.ecfToLookAngles(observerGd, satEcf);
  const elev = satellite.radiansToDegrees(look.elevation);
  return elev;
}

function bisectCrossingTime(satrec, t0, t1, obsLat, obsLon, obsAltM, targetElevDeg = 0, iters = 25) {
  // assumes elev(t0) and elev(t1) are on different sides of target
  let a = t0.getTime();
  let b = t1.getTime();
  let ea = elevationDeg(satrec, new Date(a), obsLat, obsLon, obsAltM);
  let eb = elevationDeg(satrec, new Date(b), obsLat, obsLon, obsAltM);
  if (ea === null || eb === null) return null;

  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    const em = elevationDeg(satrec, new Date(m), obsLat, obsLon, obsAltM);
    if (em === null) return null;

    // choose interval containing sign change around target
    const fa = ea - targetElevDeg;
    const fm = em - targetElevDeg;
    if (fa === 0) return new Date(a);
    if ((fa > 0 && fm > 0) || (fa < 0 && fm < 0)) {
      a = m; ea = em;
    } else {
      b = m; eb = em;
    }
  }
  return new Date((a + b) / 2);
}

function findMaxElevation(satrec, aos, los, obsLat, obsLon, obsAltM) {
  // sample between AOS and LOS to find TCA and max elevation (simple but robust)
  const start = aos.getTime();
  const end = los.getTime();
  const step = 5 * 1000; // 5s sampling
  let best = { t: new Date(start), elev: -999 };
  for (let ms = start; ms <= end; ms += step) {
    const e = elevationDeg(satrec, new Date(ms), obsLat, obsLon, obsAltM);
    if (e !== null && e > best.elev) best = { t: new Date(ms), elev: e };
  }
  return best;
}

function formatLocal(dt) {
  // show local time string (browser locale)
  return dt.toLocaleString(undefined, { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

async function computeNextPasses(satrec, name, obsLat, obsLon, obsAltM, nPasses, searchHours) {
  statusEl.textContent = "Geçişler hesaplanıyor…";
  passesWrap.innerHTML = "";

  const start = new Date(); // now
  const end = new Date(start.getTime() + searchHours * 3600 * 1000);

  const stepMs = 20 * 1000; // 20s coarse scan
  let prevT = new Date(start);
  let prevE = elevationDeg(satrec, prevT, obsLat, obsLon, obsAltM);
  if (prevE === null) prevE = -999;

  const passes = [];
  let inPass = prevE > 0;

  // If already above horizon, find LOS by scanning forward; but also find AOS as "now"
  let currentAOS = inPass ? new Date(start) : null;

  for (let tMs = start.getTime() + stepMs; tMs <= end.getTime(); tMs += stepMs) {
    const t = new Date(tMs);
    const e = elevationDeg(satrec, t, obsLat, obsLon, obsAltM);
    if (e === null) continue;

    // crossing up: AOS
    if (!inPass && prevE <= 0 && e > 0) {
      const aos = bisectCrossingTime(satrec, prevT, t, obsLat, obsLon, obsAltM, 0);
      inPass = true;
      currentAOS = aos || new Date(t);
    }

    // crossing down: LOS
    if (inPass && prevE > 0 && e <= 0) {
      const los = bisectCrossingTime(satrec, prevT, t, obsLat, obsLon, obsAltM, 0);
      inPass = false;
      const finalLOS = los || new Date(t);

      if (currentAOS && finalLOS > currentAOS) {
        const peak = findMaxElevation(satrec, currentAOS, finalLOS, obsLat, obsLon, obsAltM);
        passes.push({
          aos: currentAOS,
          los: finalLOS,
          tca: peak.t,
          maxElev: peak.elev,
        });
        if (passes.length >= nPasses) break;
      }
      currentAOS = null;
    }

    prevT = t;
    prevE = e;
  }

  if (!passes.length) {
    statusEl.textContent = `Sonraki ${searchHours} saatte geçiş bulunamadı (ufuk üstü elev>0 koşulu).`;
    return;
  }

  // render table
  const rows = passes.map((p, i) => {
    const durSec = Math.max(0, (p.los.getTime() - p.aos.getTime()) / 1000);
    const durMin = (durSec / 60).toFixed(1);
    return `
      <tr>
        <td>${i + 1}</td>
        <td>${formatLocal(p.aos)}</td>
        <td>${formatLocal(p.los)}</td>
        <td>${durMin} dk</td>
        <td>${p.maxElev.toFixed(1)}°<br><span class="small">(${formatLocal(p.tca)})</span></td>
      </tr>
    `;
  }).join("");

  passesWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>AOS</th>
          <th>LOS</th>
          <th>Süre</th>
          <th>Max Elev</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  statusEl.textContent = `${name}: ${passes.length} geçiş listelendi.`;
}

// ===== Main draw/live
let currentSatrec = null;
let currentName = null;
let liveTimer = null;

async function drawTrack() {
  const start = new Date(dtEl.value);
  const hoursForward = parseInt(hoursEl.value, 10);

  const { name, l1, l2 } = await fetchLocalTLE();
  currentName = name;
  currentSatrec = satellite.twoline2satrec(l1, l2);

  const pts = groundTrackPoints(currentSatrec, start, hoursForward);
  trackLine.setLatLngs(pts.map(p => [p.lat, p.lon]));

  if (pts.length) {
    const p0 = pts[0];
    setMarkerPopup(currentName, p0.date, p0.lat, p0.lon, p0.altKm);
    map.panTo([p0.lat, p0.lon], { animate: false });
  }
  statusEl.innerHTML =
    `<div><b>Track</b>: ${pts.length} nokta</div>` +
    `<div>Başlangıç: ${pts[0]?.date?.toISOString() || "-"}</div>` +
    `<div>Bitiş: ${pts[pts.length - 1]?.date?.toISOString() || "-"}</div>`;
}

function startLive() {
  if (!currentSatrec) {
    statusEl.textContent = "Önce Çiz’e bas (TLE oku + satrec oluştur).";
    return;
  }
  btnStop.disabled = false;
  btnLive.disabled = true;
  dtEl.disabled = true;
  hoursEl.disabled = true;

  liveTimer = setInterval(() => {
    const d = new Date();
    const gd = eciGeodeticFromSatrec(currentSatrec, d);
    if (!gd) return;
    nowMarker.setLatLng([gd.lat, gd.lon]);
  }, 1000);

  statusEl.textContent = "Canlı takip açık (1 sn).";
}

function stopLive() {
  clearInterval(liveTimer);
  liveTimer = null;
  btnStop.disabled = true;
  btnLive.disabled = false;
  dtEl.disabled = false;
  hoursEl.disabled = false;
  statusEl.textContent = "Canlı takip durduruldu.";
}

// events
btnDraw.addEventListener("click", async () => {
  try {
    await drawTrack();
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Hata: " + e.message;
  }
});

btnLive.addEventListener("click", startLive);
btnStop.addEventListener("click", stopLive);

btnCalcPasses.addEventListener("click", async () => {
  try {
    if (!currentSatrec) {
      await drawTrack(); // ensure satrec exists
    }
    const obsLat = parseFloat(olatEl.value);
    const obsLon = parseFloat(olonEl.value);
    const obsAltM = parseFloat(oaltEl.value);
    const nPasses = parseInt(npassesEl.value, 10);
    const searchHours = parseInt(searchHoursEl.value, 10);

    await computeNextPasses(currentSatrec, currentName || `NORAD ${NORAD_ID}`, obsLat, obsLon, obsAltM, nPasses, searchHours);
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Hata: " + e.message;
  }
});

// initial

btnDraw.click();
