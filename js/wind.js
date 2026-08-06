/* ============================================================
   MODULES VENT
     1. WindData  — sources de séries temporelles horaires (non enregistré :
                    utilisé par le graphique et par l'export)
     2. WindNow   — cartes de vent en temps réel (SWOB, repli Open-Meteo)
     3. MetWidget — météo à la date survolée sur le graphique
   ============================================================ */

const dirName = d => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSO","SO","OSO","O","ONO","NO","NNO"][Math.round(d/22.5)%16];

/* ============================================================
   1. SOURCES DE SÉRIES DE VENT
   ------------------------------------------------------------
   Un point : { x:ms, speed:km/h, dir:degrés, gust:km/h, temp:°C }

   ECCC climate-hourly  : observations réelles horaires (pas de rafales).
   Open-Meteo           : réanalyse (archive, décalage ~5 j) + prévision
                          pour les jours récents ; couvre n'importe quel
                          point, fournit les rafales.
   ============================================================ */
const WindData = {
  OM_LAG_DAYS: 6,          // marge avant le décalage de l'archive Open-Meteo
  OM_FORECAST_MAX: 90,     // profondeur maximale du point d'accès prévision

  /* Point d'entrée : renvoie les points horaires pour une station configurée */
  async series(ws, fromMs, toMs, opts={}){
    let pts = [], source = null;
    if (ws.climateId){
      pts = await this.eccc(ws.climateId, fromMs, toMs).catch(()=>[]);
      if (pts.length) source = "eccc";
    }
    if (!pts.length){
      pts = await this.openMeteo(ws.lat, ws.lon, fromMs, toMs).catch(()=>[]);
      source = pts.length ? "openmeteo" : null;
    } else if (opts.needGust){
      // les archives ECCC ne contiennent pas les rafales : complément Open-Meteo
      const om = await this.openMeteo(ws.lat, ws.lon, fromMs, toMs).catch(()=>[]);
      if (om.length){
        const byHour = new Map(om.map(p=>[Math.round(p.x/36e5), p.gust]));
        pts = pts.map(p=>({ ...p, gust: p.gust ?? byHour.get(Math.round(p.x/36e5)) ?? null }));
      }
    }
    pts.source = source;
    return pts;
  },

  /* ---- ECCC — archives climatiques horaires ---- */
  async eccc(climateId, fromMs, toMs){
    const chunk = 60*864e5;               // 60 jours par requête
    const reqs = [];
    for (let t = fromMs; t < toMs; t += chunk){
      const to = Math.min(t+chunk, toMs);
      reqs.push(fetchJSON(`https://api.weather.gc.ca/collections/climate-hourly/items?f=json` +
        `&CLIMATE_IDENTIFIER=${climateId}&datetime=${iso(t)}/${iso(to)}&limit=2000` +
        `&properties=LOCAL_DATE,UTC_DATE,WIND_SPEED,WIND_DIRECTION,TEMP&sortby=LOCAL_DATE`)
        .catch(()=>({features:[]})));
    }
    const pts = [];
    for (const d of await Promise.all(reqs))
      for (const f of d.features||[]){
        const p = f.properties, x = this.ecccTime(p);
        if (x == null) continue;
        pts.push({ x, speed:p.WIND_SPEED ?? null,
          dir: p.WIND_DIRECTION != null ? p.WIND_DIRECTION*10 : null,   // dizaines de degrés
          gust: null, temp: p.TEMP ?? null });
      }
    pts.sort((a,b)=>a.x-b.x);
    return pts;
  },
  ecccTime(p){
    const raw = p.UTC_DATE || p.LOCAL_DATE;
    if (!raw) return null;
    let s = String(raw).replace(" ", "T");
    if (!/[Zz]$|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
    let ms = Date.parse(s);
    if (isNaN(ms)) return null;
    // LOCAL_DATE est en heure normale de l'Est toute l'année (UTC−5)
    if (!p.UTC_DATE) ms += 5*36e5;
    return ms;
  },

  /* ---- Open-Meteo — archive (ancien) + prévision (récent) ---- */
  async openMeteo(lat, lon, fromMs, toMs){
    const HOURLY = "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m";
    const q = `&hourly=${HOURLY}&wind_speed_unit=kmh&timezone=UTC`;
    const cut = Date.now() - this.OM_LAG_DAYS*864e5;
    const jobs = [];
    if (fromMs < cut){
      const to = Math.min(toMs, cut);
      jobs.push(fetchJSON(`https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
        `&start_date=${dayStr(fromMs)}&end_date=${dayStr(to)}${q}`).catch(()=>null));
    }
    if (toMs > cut){
      const from = Math.max(fromMs, Math.max(cut, Date.now() - this.OM_FORECAST_MAX*864e5));
      jobs.push(fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&start_date=${dayStr(from)}&end_date=${dayStr(toMs)}${q}`).catch(()=>null));
    }
    const seen = new Set(), pts = [];
    for (const d of await Promise.all(jobs)){
      const h = d?.hourly; if (!h?.time) continue;
      for (let i=0; i<h.time.length; i++){
        const x = Date.parse(h.time[i] + (/[Zz]$/.test(h.time[i]) ? "" : "Z"));
        if (isNaN(x) || seen.has(x) || x < fromMs || x > toMs) continue;
        const speed = h.wind_speed_10m?.[i] ?? null, temp = h.temperature_2m?.[i] ?? null;
        if (speed == null && temp == null) continue;
        seen.add(x);
        pts.push({ x, speed, dir:h.wind_direction_10m?.[i] ?? null,
          gust:h.wind_gusts_10m?.[i] ?? null, temp });
      }
    }
    pts.sort((a,b)=>a.x-b.x);
    return pts;
  }
};

/* ============================================================
   2. VENT TEMPS RÉEL — cartes + flèches sur la carte
   ============================================================ */
App.register({
  async swob(st){
    const d = await fetchJSON(`https://api.weather.gc.ca/collections/swob-realtime/items?f=json&icao_stn_id-value=${st.icao}&limit=1&sortby=-date_tm-value`);
    const p = d.features?.[0]?.properties; if(!p) throw new Error("aucune obs");
    const g = d.features[0].geometry.coordinates;
    return { name:p["stn_nam-value"]||st.name, lat:g[1], lon:g[0],
      speed:p["avg_wnd_spd_10m_pst10mts"] ?? p["avg_wnd_spd_10m_pst2mts"] ?? p["avg_wnd_spd_10m_pst1hr"],
      dir:  p["avg_wnd_dir_10m_pst10mts"] ?? p["avg_wnd_dir_10m_pst2mts"] ?? p["avg_wnd_dir_10m_pst1hr"],
      gust: p["max_wnd_gst_spd_10m_pst10mts"] ?? p["max_wnd_gst_spd_10m_pst1hr"],
      temp: p["air_temp"], time:new Date(p["date_tm-value"]) };
  },
  async openMeteo(st){
    const d = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m&wind_speed_unit=kmh`);
    const c = d.current;
    return { name:st.name+" (modèle)", lat:st.lat, lon:st.lon, speed:c.wind_speed_10m,
      dir:c.wind_direction_10m, gust:c.wind_gusts_10m, temp:c.temperature_2m, time:new Date(c.time) };
  },
  async refresh(){
    const grid = document.getElementById("wind-grid");
    const obs = await Promise.allSettled(CONFIG.windStations.map(st=>this.swob(st).catch(()=>this.openMeteo(st))));
    grid.innerHTML = "";
    window._windData = [];
    obs.forEach((res,i)=>{
      const st = CONFIG.windStations[i];
      if (res.status!=="fulfilled"){ grid.insertAdjacentHTML("beforeend",`<div class="wind-row"><div class="wind-info"><div class="place">${st.name}</div><div class="err">Indisponible</div></div></div>`); return; }
      const o = res.value, dir = o.dir ?? 0;
      window._windData.push(o);
      grid.insertAdjacentHTML("beforeend", `
        <div class="wind-row">
          <svg class="compass" viewBox="0 0 60 60">
            <circle cx="30" cy="30" r="27" fill="#141d2e" stroke="#243149" stroke-width="2"/>
            <text x="30" y="12" fill="#8fa1bb" font-size="8" text-anchor="middle">N</text>
            <g transform="rotate(${dir+180},30,30)"><path d="M30 10 L36 34 L30 28 L24 34 Z" fill="#3fb6ff"/></g>
          </svg>
          <div class="wind-info">
            <div class="place">${o.name}</div>
            <div class="speed">${o.speed!=null?Math.round(o.speed):"–"} <small>km/h${o.gust!=null?` · rafales ${Math.round(o.gust)}`:""}</small></div>
            <div class="detail">${o.dir!=null?`${dirName(dir)} (${Math.round(dir)}°) · `:""}${o.temp!=null?o.temp.toFixed(1)+" °C · ":""}${o.time.toLocaleTimeString("fr-CA",{hour:"2-digit",minute:"2-digit"})}</div>
          </div>
        </div>`);
      if (o.speed!=null) window._updateWind?.(o);
    });
  }
});

/* ============================================================
   3. WIDGET MÉTÉO — survol / clic sur le graphique
   Lit les séries de vent déjà chargées par le graphique : aucune
   requête supplémentaire, affichage instantané au survol.
   Clic = épingler la date ; nouveau clic = désépingler.
   ============================================================ */
const MetWidget = {
  pinned:false, _raf:null, _lastX:null,
  nearest(pts, x){
    if (!pts?.length) return null;
    let lo=0, hi=pts.length-1;
    while (hi-lo>1){ const m=(lo+hi)>>1; pts[m].x<x?lo=m:hi=m; }
    const best = Math.abs(pts[lo].x-x)<Math.abs(pts[hi].x-x)?pts[lo]:pts[hi];
    return Math.abs(best.x-x) <= 2*36e5 ? best : null; // ≤ 2 h d'écart
  },
  show(x, click){
    if (this.pinned && !click) return;
    if (click) this.pinned = !this.pinned;
    this._lastX = x;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(()=>this.render(x));
  },
  redraw(){ if (this._lastX != null) this.render(this._lastX); },
  render(x){
    const panel = document.getElementById("met-widget");
    const store = (typeof Levels !== "undefined" && Levels.windData) || {};
    const list = CONFIG.windSeries.filter(ws=>store[ws.key]?.length);
    if (!list.length){ panel.classList.remove("open"); return; }
    panel.classList.add("open");
    const dstr = new Date(x).toLocaleString("fr-CA",{dateStyle:"medium",timeStyle:"short"});
    const cards = list.map(ws=>{
      const o = this.nearest(store[ws.key], x);
      if (!o) return `<div class="mw-card"><div><div class="mw-place">${ws.name}</div><div class="mw-sub">Pas de donnée à ±2 h</div></div></div>`;
      const dir = o.dir ?? 0;
      const tcol = o.temp==null?"var(--muted)":o.temp<=0?"#7ecbff":o.temp<15?"#8fd8c5":o.temp<25?"#ffd479":"#ff9d6b";
      return `
        <div class="mw-card">
          <svg class="big-compass" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="36" fill="var(--panel2)" stroke="var(--border)" stroke-width="2"/>
            <text x="40" y="13" fill="var(--muted)" font-size="9" text-anchor="middle">N</text>
            <text x="40" y="74" fill="var(--muted)" font-size="9" text-anchor="middle">S</text>
            ${o.dir!=null?`<g transform="rotate(${dir+180},40,40)">
              <path d="M40 12 L48 46 L40 38 L32 46 Z" fill="${ws.color||"var(--accent)"}"/>
            </g>`:`<text x="40" y="44" fill="var(--muted)" font-size="9" text-anchor="middle">dir ?</text>`}
            <circle cx="40" cy="40" r="4" fill="var(--panel)" stroke="${ws.color||"var(--accent)"}"/>
          </svg>
          <div>
            <div class="mw-place">${ws.name}</div>
            <div class="mw-temp" style="color:${tcol}">${o.temp!=null?o.temp.toFixed(1)+" °C":"–"}</div>
            <div class="mw-wind">${o.speed!=null?Math.round(o.speed)+" km/h":"vent –"}${o.gust!=null?` <small>· raf. ${Math.round(o.gust)}</small>`:""}</div>
            <div class="mw-sub">${o.dir!=null?dirName(dir)+" "+Math.round(dir)+"° · ":""}${new Date(o.x).toLocaleString("fr-CA",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>
          </div>
        </div>`;
    }).join("");
    panel.innerHTML = `
      <div class="mw-head"><span>Vent et température le <b>${dstr}</b></span>
        <span class="mw-pin ${this.pinned?"pinned":""}">${this.pinned?"📌 épinglé (cliquer le graphique pour libérer)":"suit le curseur — cliquer pour épingler"}</span></div>
      <div class="mw-grid">${cards}</div>`;
  }
};
