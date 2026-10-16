/* Wohnungsradar Wien – PWA (reines JS, kein Build) */
(() => {
  const CFG = window.RADAR_CONFIG;
  const $view = document.getElementById("view");
  const $status = document.getElementById("topstatus");
  const state = { token: null, boot: null, listings: null, filter: "neu", showFailed: false, map: null, markers: null, mapLayers: {}, detailCache: {} };

  // ---------- Zugang ----------
  function readToken() {
    const u = new URL(location.href);
    let t = u.searchParams.get("t");
    if (!t && location.hash.includes("t=")) t = new URLSearchParams(location.hash.replace(/^#\/?\??/, "")).get("t");
    if (t) {
      try { localStorage.setItem("radar_token", t); } catch { /* egal */ }
      u.searchParams.delete("t");
      history.replaceState(null, "", u.pathname + (u.search || "") + (location.hash.includes("t=") ? "#/list" : location.hash || "#/list"));
      return t;
    }
    try { return localStorage.getItem("radar_token"); } catch { return null; }
  }

  // ---------- API ----------
  async function api(action, payload = {}) {
    const res = await fetch(CFG.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-token": state.token || "" },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { state.token = null; render(); throw new Error("Kein Zugang (Schlüssel ungültig)"); }
    if (!res.ok) throw new Error(data.error || ("Fehler " + res.status));
    return data;
  }

  // ---------- Hilfen ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const eur = (n) => n == null ? "–" : Math.round(n).toLocaleString("de-AT") + " €";
  const num = (n, unit = "") => n == null ? "–" : (Math.round(n * 10) / 10).toLocaleString("de-AT") + unit;
  const dateShort = (s) => s ? new Date(s).toLocaleDateString("de-AT", { day: "2-digit", month: "2-digit" }) : "";
  const dateLong = (s) => s ? new Date(s).toLocaleString("de-AT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
  function scoreColor(s) { if (s == null) return "#8a8f8c"; if (s >= 80) return "var(--s5)"; if (s >= 65) return "var(--s4)"; if (s >= 50) return "var(--s3)"; if (s >= 35) return "var(--s2)"; return "var(--s1)"; }
  function scoreHex(s) { if (s == null) return "#8a8f8c"; if (s >= 80) return "#1f8a4c"; if (s >= 65) return "#6cae3e"; if (s >= 50) return "#d9b11a"; if (s >= 35) return "#e08a2e"; return "#d64545"; }
  const statusLabel = { neu: "Neu", favorit: "Favorit", besichtigt: "Besichtigt", abgesagt: "Abgesagt" };
  let toastT;
  function toast(msg, ms = 2600) {
    const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function isStandalone() { return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }

  // ---------- Routing ----------
  function route() {
    const h = location.hash || "#/list";
    const m = h.match(/^#\/(\w+)(?:\/([^/?]+))?/);
    return { name: m ? m[1] : "list", id: m ? m[2] : null };
  }
  window.addEventListener("hashchange", render);

  async function render() {
    if (!state.token) { renderNoKey(); return; }
    const r = route();
    document.querySelectorAll("#tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === r.name || (r.name === "detail" && a.dataset.tab === "list")));
    try {
      if (!state.boot) { $view.innerHTML = '<div class="loading">Lade …</div>'; state.boot = await api("bootstrap"); }
      if (r.name === "list") await renderList();
      else if (r.name === "map") await renderMap();
      else if (r.name === "detail") await renderDetail(r.id);
      else if (r.name === "settings") await renderSettings();
      else location.hash = "#/list";
    } catch (e) {
      $view.innerHTML = `<div class="card"><b>Fehler:</b> ${esc(e.message)}<br><button class="btn secondary" style="margin-top:10px" onclick="location.reload()">Neu laden</button></div>`;
    }
  }

  function renderNoKey() {
    $view.innerHTML = document.getElementById("tpl-nokey").innerHTML;
    document.getElementById("keysave").onclick = () => {
      const v = document.getElementById("keyinput").value.trim();
      if (!v) return;
      try { localStorage.setItem("radar_token", v); } catch { /* egal */ }
      state.token = v; state.boot = null; render();
    };
  }

  // ---------- Liste ----------
  async function loadListings(force = false) {
    if (!state.listings || force) {
      const d = await api("listings", { status: "alle", include_hard_fail: true });
      state.listings = d.listings;
    }
    return state.listings;
  }
  function filtered() {
    let rows = state.listings || [];
    if (!state.showFailed) rows = rows.filter((r) => r.hard_ok !== false);
    if (state.filter === "neu") rows = rows.filter((r) => !r.rating_status || r.rating_status === "neu");
    else if (state.filter !== "alle") rows = rows.filter((r) => r.rating_status === state.filter);
    return rows;
  }
  async function renderList() {
    $view.innerHTML = '<div class="loading">Lade Inserate …</div>';
    await loadListings();
    const rows = filtered();
    const counts = { neu: 0, favorit: 0, besichtigt: 0, abgesagt: 0 };
    for (const r of state.listings) { if (r.hard_ok === false && !state.showFailed) continue; counts[r.rating_status || "neu"] = (counts[r.rating_status || "neu"] || 0) + 1; }
    const chip = (k, label) => `<button class="chip ${state.filter === k ? "active" : ""}" data-f="${k}">${label}${counts[k] != null ? ` <span class="muted">${counts[k]}</span>` : ""}</button>`;
    $view.innerHTML = `
      <div class="chips">${chip("neu", "Neu")}${chip("favorit", "Favoriten")}${chip("besichtigt", "Besichtigt")}${chip("abgesagt", "Abgesagt")}${chip("alle", "Alle")}
        <button class="chip ${state.showFailed ? "active" : ""}" data-f="__failed">Ausgeschlossene</button></div>
      ${installHint()}
      <div class="list">${rows.length ? rows.map(itemHtml).join("") : '<div class="empty">Nichts in dieser Ansicht.<br><span class="small">Neue Inserate kommen täglich am Morgen.</span></div>'}</div>
      <p class="muted small" style="margin-top:14px">${state.listings.length} aktive Inserate · Stand ${state.boot.runs?.[0]?.started_at ? dateLong(state.boot.runs[0].started_at) : "–"}</p>`;
    $view.querySelectorAll(".chip[data-f]").forEach((b) => b.onclick = () => {
      if (b.dataset.f === "__failed") state.showFailed = !state.showFailed; else state.filter = b.dataset.f;
      renderList();
    });
    $status.textContent = "";
  }
  function itemHtml(r) {
    const st = r.rating_status && r.rating_status !== "neu" ? `<span class="chip tag">${statusLabel[r.rating_status]}</span>` : "";
    const stars = r.rating_stars ? `<span class="muted">${"★".repeat(r.rating_stars)}</span>` : "";
    const newTag = (Date.now() - new Date(r.first_seen).getTime()) < 36 * 3600e3 ? '<span class="chip tag ok">neu</span>' : "";
    return `<a class="item ${r.hard_ok === false ? "failed" : ""}" href="#/detail/${r.id}">
      ${r.image ? `<img class="thumb" src="${esc(r.image)}" alt="" loading="lazy">` : '<div class="thumb"></div>'}
      <div>
        <div class="title">${esc(r.title || "Ohne Titel")}</div>
        <div class="facts">${r.district ? r.district + ". Bezirk" : esc(r.plz || "")} · ${eur(r.price)} · ${num(r.area_m2, " m²")} · ${r.rooms ? r.rooms + " Zi" : "? Zi"} ${r.price && r.area_m2 ? "· " + Math.round(r.price / r.area_m2).toLocaleString("de-AT") + " €/m²" : ""}</div>
        <div class="reason">${esc(r.hard_ok === false ? "Ausgeschlossen: " + (r.hard_fail || []).join(", ") : (r.reasoning || "Noch nicht bewertet"))}</div>
        <div class="row small" style="margin-top:4px">${newTag}${st}${stars}<span class="muted">${esc(r.source)} · ${dateShort(r.first_seen)}</span></div>
      </div>
      <div class="badge" style="background:${scoreColor(r.score)}">${r.score ?? "–"}<small>Score</small></div>
    </a>`;
  }
  function installHint() {
    if (isStandalone()) return "";
    if (isIOS()) return `<div class="hint" style="margin-bottom:10px">Auf dem iPhone installieren: unten <b>Teilen</b> → <b>Zum Home-Bildschirm</b>. Nur die installierte App kann Push-Nachrichten empfangen.</div>`;
    return `<div class="hint" style="margin-bottom:10px">Tipp: Diese Seite lässt sich als App installieren (Browser-Menü → „App installieren“ / „Zum Startbildschirm“).</div>`;
  }

  // ---------- Karte ----------
  async function renderMap() {
    $view.innerHTML = `<div class="map-wrap"><div id="map"></div>
      <div class="layers">
        <label><input type="checkbox" id="ly-noise"> Lärm (Straße, Tag)</label>
        <label><input type="checkbox" id="ly-rail"> Lärm (Schiene, Tag)</label>
        <label><input type="checkbox" id="ly-oepnv"> Öffis</label>
        <label><input type="checkbox" id="ly-green"> Grünflächen</label>
        <label><input type="checkbox" id="ly-failed" ${state.showFailed ? "checked" : ""}> Ausgeschlossene</label>
      </div></div>
      <p class="muted small" style="margin-top:8px">Farbe der Pins = Score. Gelber Rand = schon bewertet. Lärm: Umgebungslärmkartierung 2022 (Bund); Grünflächen: Stadt Wien Open Data.</p>`;
    await loadListings();
    const map = L.map("map", { zoomControl: false }).setView([48.21, 16.35], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    const layers = {
      noise: L.tileLayer.wms("https://inspire.lfrz.gv.at/000804/wms", { layers: "2022_STRASSE_24H_ZONEN_OE", format: "image/png", transparent: true, opacity: .55, attribution: "Umgebungslärm BMK/LFRZ" }),
      rail: L.tileLayer.wms("https://inspire.lfrz.gv.at/000804/wms", { layers: "2022_SCHIENE_24H_ZONEN_OE", format: "image/png", transparent: true, opacity: .55 }),
      oepnv: L.tileLayer("https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png", { maxZoom: 18, opacity: .8, attribution: "ÖPNV-Karte memomaps.de" }),
      green: L.tileLayer.wms("https://data.wien.gv.at/daten/geo", { layers: "ogdwien:OEFFGRUENFLOGD", format: "image/png", transparent: true, opacity: .5, attribution: "Stadt Wien data.wien.gv.at" }),
    };
    for (const k of Object.keys(layers)) document.getElementById("ly-" + k).onchange = (e) => e.target.checked ? layers[k].addTo(map) : map.removeLayer(layers[k]);
    const group = L.layerGroup().addTo(map);
    const draw = () => {
      group.clearLayers();
      const rows = (state.listings || []).filter((r) => r.lat && r.lng && (state.showFailed || r.hard_ok !== false));
      for (const r of rows) {
        const icon = L.divIcon({ className: "", html: `<div class="pin ${r.rating_stars ? "rated" : ""}" style="background:${scoreHex(r.score)}">${r.score ?? "?"}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
        L.marker([r.lat, r.lng], { icon }).addTo(group).bindPopup(`<b>${esc(r.title || "")}</b><br>${r.district ? r.district + ". Bezirk" : ""} · ${eur(r.price)} · ${num(r.area_m2, " m²")}<br><a href="#/detail/${r.id}">Details</a>`);
      }
    };
    draw();
    document.getElementById("ly-failed").onchange = (e) => { state.showFailed = e.target.checked; draw(); };
    setTimeout(() => map.invalidateSize(), 50);
  }

  // ---------- Detail ----------
  async function renderDetail(id) {
    $view.innerHTML = '<div class="loading">Lade …</div>';
    const d = await api("listing", { id });
    const l = d.listing, sc = Array.isArray(l.scores) ? l.scores[0] : l.scores, rt = (Array.isArray(l.ratings) ? l.ratings[0] : l.ratings) || {}, en = (Array.isArray(l.enrichments) ? l.enrichments[0] : l.enrichments) || {};
    const crit = state.boot.criteria;
    const a = sc?.assessment || {};
    const tri = (v) => v === "ja" || v === "erfuellt" ? "ok" : v === "nein" || v === "nicht" ? "no" : "unk";
    const triTxt = (v) => v === "ja" || v === "erfuellt" ? "✓" : v === "nein" || v === "nicht" ? "✗" : "?";
    const hardLabels = { selbstbezug: "Selbstbezug", lift_oder_eg: "Lift/EG", zimmer: "Zimmer", flaeche: "Fläche", preis: "Preis", bezirk_graetzl: "Bezirk/Grätzl" };
    const hardChips = Object.entries(a.hart || {}).map(([k, v]) => `<span class="chip tag ${tri(v)}">${triTxt(v)} ${hardLabels[k] || k}</span>`).join("");
    const softChips = (crit.soft || []).map((s) => { const v = (a.weich || {})[s.key]; return `<span class="chip tag ${tri(v)}" title="Gewicht ${s.weight}">${triTxt(v)} ${esc(s.label)}</span>`; }).join("");
    const t = en.transit || {}, n = en.noise || {}, g = en.green || {}, p = en.price_ctx, z = en.zoning || {}, f = en.flood || {}, links = en.links || {};
    const dbTxt = (x) => x && x.db != null ? `${x.db} dB` : x && x.label ? x.label : "–";
    $view.innerHTML = `
      <a class="back" href="#/list">‹ Liste</a>
      ${(l.images || []).length ? `<div class="gallery">${l.images.slice(0, 15).map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join("")}</div>` : ""}
      <div class="card">
        <div class="row between"><h2 style="margin:0">${esc(l.title || "Ohne Titel")}</h2><div class="badge" style="background:${scoreColor(sc?.score)}">${sc?.score ?? "–"}<small>Score</small></div></div>
        <div class="muted small">${esc(l.address || "")}${l.plz ? " · " + l.plz : ""}${l.district ? " · " + l.district + ". Bezirk" : ""} · Quelle ${esc(l.source)} · gefunden ${dateShort(l.first_seen)}</div>
        <div class="facts-grid" style="margin-top:10px">
          <div><b>${eur(l.price)}</b><span>Kaufpreis</span></div>
          <div><b>${num(l.area_m2, " m²")}</b><span>Wohnfläche</span></div>
          <div><b>${l.rooms ?? "–"}</b><span>Zimmer</span></div>
          <div><b>${l.price && l.area_m2 ? Math.round(l.price / l.area_m2).toLocaleString("de-AT") + " €" : "–"}</b><span>pro m²${p ? " · " + esc(p.einschaetzung) : ""}</span></div>
          <div><b>${esc(l.floor || en.orientation || "–")}</b><span>Stock / Lage</span></div>
          <div><b>${esc(l.seller_type || "–")}</b><span>Anbieter</span></div>
        </div>
        <div class="links" style="margin-top:12px">
          <a class="primary" href="${esc(l.url)}" target="_blank" rel="noopener">Zum Inserat ↗</a>
          ${links.streetview ? `<a href="${esc(links.streetview)}" target="_blank" rel="noopener">Street View</a>` : ""}
          ${links.maps ? `<a href="${esc(links.maps)}" target="_blank" rel="noopener">Google Maps</a>` : ""}
          ${d.duplicates?.length ? d.duplicates.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">auch auf ${esc(x.source)}</a>`).join("") : ""}
        </div>
      </div>

      <div class="card">
        <h3>Deine Bewertung</h3>
        <div class="row between">
          <div class="stars" id="stars">${[1, 2, 3, 4, 5].map((i) => `<button data-s="${i}" class="${rt.stars >= i ? "on" : ""}">★</button>`).join("")}</div>
          <div class="seg" id="status">${Object.entries(statusLabel).map(([k, v]) => `<button data-st="${k}" class="${(rt.status || "neu") === k ? "active" : ""}">${v}</button>`).join("")}</div>
        </div>
        <label class="field"><span>Was gefällt, was nicht? (daraus lernt der Radar)</span><textarea id="note">${esc(rt.note || "")}</textarea></label>
        <div class="row between"><span class="muted small">${rt.updated_at ? "Gespeichert " + dateLong(rt.updated_at) : "Noch nicht bewertet"}</span><button class="btn" id="save">Speichern</button></div>
      </div>

      <div class="card">
        <h3>Bewertung durch Claude</h3>
        ${sc ? `<p>${esc(sc.reasoning || "")}</p>
          ${sc.hard_ok === false ? `<p class="chip tag no">Harte Kriterien verletzt: ${esc((sc.hard_fail || []).join(", "))}</p>` : ""}
          ${(sc.warnings || []).length ? `<ul class="warnlist">${sc.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
          <div class="row" style="margin-top:8px">${hardChips}</div>
          <div class="row" style="margin-top:6px">${softChips}</div>
          <p class="muted small">Modell ${esc(sc.model || "")} · Kriterienversion ${sc.criteria_version ?? "–"} · ${dateLong(sc.updated_at)}</p>`
        : `<p class="muted">Noch nicht bewertet.</p>`}
        <button class="btn secondary small" id="rescore-one">Dieses Inserat neu bewerten</button>
      </div>

      <div class="card">
        <h3>Umfeld</h3>
        <dl class="kv">
          <dt>U-Bahn</dt><dd>${t.ubahn ? `${esc(t.ubahn.name)} – ${t.ubahn.minuten} Min. zu Fuß (${t.ubahn.dist_m} m)${t.ubahn.lines?.length ? " · " + esc(t.ubahn.lines.join(", ")) : ""}` : "–"}</dd>
          <dt>Bim</dt><dd>${t.bim ? `${esc(t.bim.name)} – ${t.bim.minuten} Min. (${t.bim.dist_m} m)${t.bim.lines?.length ? " · " + esc(t.bim.lines.join(", ")) : ""}` : "–"}</dd>
          <dt>Lärm</dt><dd>${esc(n.einschaetzung || "–")} · Straße Tag ${dbTxt(n.strasse_tag)}, Nacht ${dbTxt(n.strasse_nacht)} · Schiene Tag ${dbTxt(n.schiene_tag)}${n.osm?.hauptstrassen?.length ? "<br>Hauptstraßen in der Nähe: " + n.osm.hauptstrassen.map((r) => esc(r.name || r.type) + (r.dist_m != null ? ` (${r.dist_m} m)` : "")).join(", ") : ""}${n.osm?.bahn?.length ? "<br>Bahn/Bim-Gleise: " + n.osm.bahn.map((r) => esc(r.name || r.type) + (r.dist_m != null ? ` (${r.dist_m} m)` : "")).join(", ") : ""}</dd>
          <dt>Grün</dt><dd>${g.gruenflaechen_300m != null ? `${esc(g.einschaetzung)} – ${g.gruenflaechen_300m} Grünflächen im Umkreis von 300 m${g.namen?.length ? ": " + esc(g.namen.join(", ")) : ""}${g.baeume_120m != null ? ` · ${g.baeume_120m} Stadtbäume in 120 m` : ""}` : "–"}</dd>
          <dt>Preis/m²</dt><dd>${p ? `${p.eur_m2.toLocaleString("de-AT")} € vs. Bezirksschnitt ${p.bezirk_schnitt.toLocaleString("de-AT")} € (Referenz ${p.bezirk_referenz.toLocaleString("de-AT")} €, Faktor ${p.verhaeltnis}) – ${esc(p.einschaetzung)}<br><span class="muted small">${esc(p.quelle)}, Stand ${esc(p.stand)}</span>` : "–"}</dd>
          <dt>Widmung</dt><dd>${esc(z.widmung || "–")}</dd>
          <dt>Hochwasser</dt><dd>${esc(f.einschaetzung || "–")}</dd>
          <dt>Koordinaten</dt><dd>${en.geocode ? `${en.geocode.lat.toFixed(5)}, ${en.geocode.lng.toFixed(5)} <span class="muted">(${esc(en.geocode.precision)})</span>` : "–"}</dd>
        </dl>
        <div class="links" style="margin-top:10px">
          ${links.laermkarte ? `<a href="${esc(links.laermkarte)}" target="_blank" rel="noopener">Lärmkarte</a>` : ""}
          ${links.flaechenwidmung ? `<a href="${esc(links.flaechenwidmung)}" target="_blank" rel="noopener">Flächenwidmung</a>` : ""}
          ${links.hora ? `<a href="${esc(links.hora)}" target="_blank" rel="noopener">HORA Hochwasser</a>` : ""}
          ${links.osm ? `<a href="${esc(links.osm)}" target="_blank" rel="noopener">OpenStreetMap</a>` : ""}
        </div>
        ${(en.errors || []).length ? `<details style="margin-top:8px"><summary>Hinweise zur Anreicherung</summary><p class="small muted">${esc(en.errors.join(" · "))}</p></details>` : ""}
      </div>

      <div class="card">
        <details><summary>Inseratstext</summary><div class="textblock">${esc(l.raw_text || "")}</div></details>
      </div>`;

    let stars = rt.stars || null, status = rt.status || "neu";
    const starBtns = $view.querySelectorAll("#stars button");
    starBtns.forEach((b) => b.onclick = () => { stars = Number(b.dataset.s) === stars ? null : Number(b.dataset.s); starBtns.forEach((x) => x.classList.toggle("on", stars != null && Number(x.dataset.s) <= stars)); });
    const stBtns = $view.querySelectorAll("#status button");
    stBtns.forEach((b) => b.onclick = () => { status = b.dataset.st; stBtns.forEach((x) => x.classList.toggle("active", x.dataset.st === status)); });
    document.getElementById("save").onclick = async (e) => {
      e.target.disabled = true;
      try { await api("rate", { id, stars, status, note: document.getElementById("note").value }); toast("Gespeichert – fließt in die nächste Lernrunde ein."); state.listings = null; }
      catch (err) { toast("Fehler: " + err.message); }
      e.target.disabled = false;
    };
    document.getElementById("rescore-one").onclick = async (e) => {
      e.target.disabled = true;
      try { await api("enrich_one", { id }); toast("Neubewertung läuft – in etwa einer Minute neu laden."); } catch (err) { toast("Fehler: " + err.message); }
    };
  }

  // ---------- Einstellungen ----------
  async function renderSettings() {
    const b = state.boot = await api("bootstrap");
    const c = JSON.parse(JSON.stringify(b.criteria));
    const sub = await currentSubscription();
    const distBtn = (d) => { const mode = c.districts[String(d)]; return `<button data-d="${d}" class="${mode || ""}">${d}. ${mode === "teilweise" ? "teilw." : mode === "ganz" ? "ganz" : "aus"}</button>`; };
    $view.innerHTML = `
      <div class="card">
        <h3>Benachrichtigungen</h3>
        <div class="row between">
          <div>Push bei neuen Inseraten ab Score <b id="thr-val">${c.alert_threshold}</b><br><span class="muted small">${sub ? "Dieses Gerät ist angemeldet." : "Dieses Gerät ist nicht angemeldet."} ${b.counts.subscriptions} Gerät(e) gesamt.</span></div>
          <div class="row"><button class="btn ${sub ? "secondary" : ""}" id="push-toggle">${sub ? "Abmelden" : "Push einschalten"}</button><button class="btn secondary small" id="push-test" ${sub ? "" : "disabled"}>Test</button></div>
        </div>
        <input type="range" class="slider" id="thr" min="40" max="95" step="5" value="${c.alert_threshold}">
        ${isIOS() && !isStandalone() ? '<p class="hint">Auf dem iPhone funktioniert Push nur in der installierten App: Teilen → Zum Home-Bildschirm, dann hier einschalten.</p>' : ""}
      </div>

      ${(b.proposals || []).length ? `<div class="card"><h3>Vorschläge aus dem Lernen</h3>${b.proposals.map((p) => `<div class="proposal"><div>${esc(p.text)}</div><div class="row" style="margin-top:6px"><button class="btn small" data-p="${p.id}" data-a="1">Ja</button><button class="btn secondary small" data-p="${p.id}" data-a="0">Nein</button></div></div>`).join("")}</div>` : ""}

      <div class="card">
        <h3>Was der Radar bisher gelernt hat</h3>
        ${b.learning_note ? `<p>${esc(b.learning_note.note)}</p><p class="muted small">${dateLong(b.learning_note.created_at)}${(b.learning_note.applied || []).length ? " · automatisch angepasst: " + b.learning_note.applied.map((x) => `${x.key} ${x.from}→${x.to}`).join(", ") : ""}</p>` : '<p class="muted">Noch nichts – ab drei Bewertungen mit Sternen oder Text entsteht täglich eine Lernnotiz.</p>'}
      </div>

      <div class="card">
        <h3>Harte Kriterien</h3>
        <label class="field"><span>Kaufpreis höchstens (€)</span><input class="input" type="number" id="h-price" value="${c.hard.max_price}"></label>
        <div class="row">
          <label class="field" style="flex:1"><span>Mindestens Zimmer</span><input class="input" type="number" step="0.5" id="h-rooms" value="${c.hard.min_rooms}"></label>
          <label class="field" style="flex:1"><span>Mindestens m²</span><input class="input" type="number" id="h-area" value="${c.hard.min_area_m2}"></label>
        </div>
        <p class="muted small">Immer fix: Eigentum zum Selbstbezug (keine Anleger-/Vorsorgewohnung, nicht vermietet), Lift oder Erdgeschoss.</p>
        <h3>Bezirke (antippen: aus → ganz → teilweise)</h3>
        <div class="districts" id="districts">${Array.from({ length: 23 }, (_, i) => distBtn(i + 1)).join("")}</div>
        <label class="field"><span>Notizen zu „teilweise“-Bezirken (ein Bezirk pro Zeile, z. B. „2: nur Prater, Karmeliterviertel“)</span><textarea id="d-notes">${esc(Object.entries(c.district_notes || {}).filter(([k]) => k !== "_allgemein").map(([k, v]) => `${k}: ${v}`).join("\n"))}</textarea></label>
        <label class="field"><span>Allgemeine Lage-Regel</span><input class="input" id="d-general" value="${esc(c.district_notes?._allgemein || "")}"></label>
      </div>

      <div class="card">
        <h3>Weiche Kriterien – Gewicht 0 bis 5</h3>
        <div id="weights">${c.soft.map((s, i) => `<div class="weight-row"><div>${esc(s.label)}<br><input type="range" class="slider" min="${c.weight_band.min}" max="${c.weight_band.max}" step="1" value="${s.weight}" data-i="${i}"></div><div class="val" id="w-${i}">${s.weight}</div></div>`).join("")}</div>
        <label class="field"><span>Zusätzliche Hinweise für die Bewertung (Freitext)</span><textarea id="c-notes">${esc(c.notes || "")}</textarea></label>
        <label class="field"><span>Begriffe, bei denen ein Inserat gar nicht gespeichert wird (Komma-getrennt)</span><input class="input" id="c-excl" value="${esc((c.exclude_terms || []).join(", "))}"></label>
        <div class="row between" style="margin-top:8px">
          <button class="btn" id="crit-save">Kriterien speichern</button>
          <div class="row"><button class="btn secondary" id="rescore">Jetzt neu bewerten</button><button class="btn secondary" id="collect">Jetzt sammeln</button></div>
        </div>
        <p class="muted small">Gewichte wirken sofort auf alle Scores. Andere Änderungen wirken ab dem nächsten Lauf oder mit „Jetzt neu bewerten“ (dauert einige Minuten, kostet API-Guthaben).</p>
      </div>

      <div class="card">
        <h3>Quellen</h3>
        ${(b.sources || []).map((s) => `<div class="src"><input type="checkbox" data-src="${s.id}" ${s.enabled ? "checked" : ""}><div>${esc(s.name)}<br><span class="muted small">${s.last_run_at ? dateLong(s.last_run_at) + " · " + (s.last_status === "ok" ? `${s.last_count ?? 0} gefunden, ${s.last_new ?? 0} neu` : "Fehler: " + esc((s.last_error || "").slice(0, 120))) : "noch nicht gelaufen"}</span></div><span class="status-dot" style="background:${s.last_status === "ok" ? "var(--good)" : s.last_status ? "var(--bad)" : "var(--line)"}"></span></div>`).join("")}
      </div>

      <div class="card">
        <h3>Letzte Läufe</h3>
        ${(b.runs || []).map((r) => `<div class="small"><b>${esc(r.fn)}</b> ${dateLong(r.started_at)} – ${r.ok === null ? "läuft" : r.ok ? "ok" : "Fehler"}${r.error ? ": " + esc(r.error.slice(0, 100)) : ""}${r.summary?.processed != null ? ` · ${r.summary.processed} verarbeitet` : ""}${r.summary?.remaining ? `, ${r.summary.remaining} offen` : ""}</div>`).join("") || '<p class="muted">Noch keine.</p>'}
        <p class="muted small" style="margin-top:8px">Sammeln täglich 06:30 (Sommerzeit; Winter 05:30), danach Anreicherung, Bewertung, Push. Lernen täglich 10:00, Wochenrückblick sonntags 11:00. App-Version ${esc(CFG.version)}.</p>
        <button class="btn secondary small" id="logout">Zugang auf diesem Gerät vergessen</button>
      </div>`;

    // Interaktion
    document.getElementById("thr").oninput = (e) => { c.alert_threshold = Number(e.target.value); document.getElementById("thr-val").textContent = c.alert_threshold; };
    $view.querySelectorAll("#districts button").forEach((btn) => btn.onclick = () => {
      const d = btn.dataset.d, cur = c.districts[d];
      const next = !cur ? "ganz" : cur === "ganz" ? "teilweise" : null;
      if (next) c.districts[d] = next; else delete c.districts[d];
      btn.className = next || ""; btn.textContent = `${d}. ${next === "teilweise" ? "teilw." : next === "ganz" ? "ganz" : "aus"}`;
    });
    $view.querySelectorAll("#weights input[type=range]").forEach((r) => r.oninput = () => { c.soft[Number(r.dataset.i)].weight = Number(r.value); document.getElementById("w-" + r.dataset.i).textContent = r.value; });
    document.getElementById("crit-save").onclick = async (e) => {
      e.target.disabled = true;
      c.hard.max_price = Number(document.getElementById("h-price").value) || c.hard.max_price;
      c.hard.min_rooms = Number(document.getElementById("h-rooms").value) || c.hard.min_rooms;
      c.hard.min_area_m2 = Number(document.getElementById("h-area").value) || c.hard.min_area_m2;
      const notes = {};
      for (const line of document.getElementById("d-notes").value.split("\n")) { const m = line.match(/^\s*(\d{1,2})\s*[:\-–]\s*(.+)$/); if (m) notes[m[1]] = m[2].trim(); }
      notes._allgemein = document.getElementById("d-general").value.trim();
      c.district_notes = notes;
      c.notes = document.getElementById("c-notes").value.trim();
      c.exclude_terms = document.getElementById("c-excl").value.split(",").map((x) => x.trim()).filter(Boolean);
      try { const r = await api("criteria_update", { doc: c }); toast(r.hint || "Gespeichert."); state.boot = null; state.listings = null; }
      catch (err) { toast("Fehler: " + err.message); }
      e.target.disabled = false;
    };
    document.getElementById("rescore").onclick = async () => { if (confirm("Alle aktiven Inserate neu bewerten? Dauert einige Minuten.")) { await api("rescore", { mode: "rescore" }); toast("Neubewertung gestartet."); } };
    document.getElementById("collect").onclick = async () => { await api("collect_now"); toast("Sammeln gestartet – dauert 10–20 Minuten."); };
    $view.querySelectorAll("[data-p]").forEach((btn) => btn.onclick = async () => { await api("proposal_decide", { id: btn.dataset.p, accept: btn.dataset.a === "1" }); toast(btn.dataset.a === "1" ? "Übernommen." : "Abgelehnt."); state.boot = null; renderSettings(); });
    $view.querySelectorAll("[data-src]").forEach((cb) => cb.onchange = async () => { await api("sources_update", { id: cb.dataset.src, enabled: cb.checked }); toast("Quelle " + (cb.checked ? "aktiviert" : "deaktiviert")); });
    document.getElementById("logout").onclick = () => { try { localStorage.removeItem("radar_token"); } catch { /* egal */ } state.token = null; state.boot = null; render(); };
    document.getElementById("push-toggle").onclick = async (e) => {
      e.target.disabled = true;
      try { if (sub) await unsubscribePush(sub); else await subscribePush(b.vapid_public); state.boot = null; renderSettings(); }
      catch (err) { toast("Push: " + err.message, 5000); e.target.disabled = false; }
    };
    document.getElementById("push-test").onclick = async () => { try { const r = await api("test_push"); toast(r.results?.some((x) => x.ok) ? "Testnachricht gesendet." : "Senden fehlgeschlagen: " + JSON.stringify(r.results?.[0] || r)); } catch (err) { toast("Fehler: " + err.message); } };
  }

  // ---------- Push ----------
  async function swReg() {
    if (!("serviceWorker" in navigator)) return null;
    return await navigator.serviceWorker.ready;
  }
  async function currentSubscription() {
    try { const reg = await swReg(); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
  }
  function b64ToU8(b64) { const s = atob((b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (ch) => ch.charCodeAt(0)); }
  async function subscribePush(vapidPublic) {
    if (!vapidPublic) throw new Error("Server hat noch keinen Push-Schlüssel (Deployment prüfen).");
    if (!("PushManager" in window)) throw new Error(isIOS() ? "Bitte zuerst als App installieren (Teilen → Zum Home-Bildschirm)." : "Dieser Browser unterstützt keine Push-Nachrichten.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Benachrichtigungen wurden nicht erlaubt.");
    const reg = await swReg();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(vapidPublic) });
    await api("subscribe", { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 80) });
    toast("Push eingeschaltet.");
  }
  async function unsubscribePush(sub) {
    await api("unsubscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe();
    toast("Push abgemeldet.");
  }

  // ---------- Start ----------
  state.token = readToken();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!location.hash) location.hash = "#/list";
  render();
})();
