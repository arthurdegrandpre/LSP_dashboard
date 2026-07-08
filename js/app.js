/* Chart.js 4 n'enregistre pas les plugins automatiquement — indispensable pour zoom/pan */
if (window.ChartZoom) Chart.register(window.ChartZoom);

/* ============================================================
   Registre de modules — App.register({init, refresh})
   ============================================================ */
const App = {
  modules: [],
  register(m){ this.modules.push(m); },
  async init(){
    document.getElementById("cfg-interval").textContent = CONFIG.refreshMinutes;
    for (const m of this.modules) await m.init?.();
    await this.refreshAll();
    setInterval(()=>this.refreshAll(), CONFIG.refreshMinutes*60*1000);
  },
  async refreshAll(){
    await Promise.allSettled(this.modules.map(m=>m.refresh?.()));
    document.getElementById("last-update").textContent =
      "Mis à jour " + new Date().toLocaleTimeString("fr-CA",{hour:"2-digit",minute:"2-digit"});
  }
};

/* ---------- utilitaires ---------- */
const fetchJSON = async url => { const r = await fetch(url); if(!r.ok) throw new Error(r.status); return r.json(); };
const iso = d => new Date(d).toISOString().slice(0,19)+"Z";
const dayStr = d => new Date(d).toISOString().slice(0,10);

// IWLS : tranches de 48 h, sous-échantillonné
async function iwlsSeries(id, fromMs, toMs){
  const reqs = [];
  for (let t = fromMs; t < toMs; t += 48*36e5){
    reqs.push(fetchJSON(`https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${id}/data?time-series-code=wlo&from=${iso(t)}&to=${iso(Math.min(t+48*36e5, toMs))}`)
      .catch(()=>[]));
  }
  const out = (await Promise.all(reqs)).flat();
  const step = Math.max(1, Math.round(out.length/600));
  return out.filter((_,i)=>i%step===0).map(p=>({x:new Date(p.eventDate).getTime(), y:p.value}));
}
// ECCC temps réel (~1 mois d'archive)
async function geometRealtime(id, fromMs, toMs){
  const d = await fetchJSON(`https://api.weather.gc.ca/collections/hydrometric-realtime/items?f=json&STATION_NUMBER=${id}&datetime=${iso(fromMs)}/${iso(toMs)}&limit=8000&properties=DATETIME,LEVEL&sortby=DATETIME`);
  const pts = d.features.map(f=>({x:new Date(f.properties.DATETIME).getTime(), y:f.properties.LEVEL})).filter(p=>p.y!=null);
  const step = Math.max(1, Math.round(pts.length/600));
  return pts.filter((_,i)=>i%step===0);
}
// ECCC moyennes journalières historiques (HYDAT)
async function geometDaily(id, fromMs, toMs){
  const d = await fetchJSON(`https://api.weather.gc.ca/collections/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${id}&datetime=${iso(fromMs)}/${iso(toMs)}&limit=1000&properties=DATE,LEVEL&sortby=DATE`);
  return d.features.map(f=>({x:new Date(f.properties.DATE+"T12:00:00Z").getTime(), y:f.properties.LEVEL})).filter(p=>p.y!=null);
}
const seriesFor = (st, fromMs, toMs, historical=false) =>
  st.type==="iwls" ? iwlsSeries(st.id, fromMs, toMs)
  : historical ? geometDaily(st.id, fromMs, toMs) : geometRealtime(st.id, fromMs, toMs).then(p=>p.length?p:geometDaily(st.id,fromMs,toMs));

/* ============================================================
   MODULE : Niveaux d'eau (KPI + graphique interactif)
   ============================================================ */
const Levels = {
  chart:null, from:null, to:null, data:{}, histData:{},
  setRangeHours(h){ this.to = Date.now(); this.from = this.to - h*36e5; },
  async init(){
    this.setRangeHours(72);
    document.querySelectorAll(".toolbar button[data-h]").forEach(b=>{
      b.onclick = ()=>{
        document.querySelectorAll(".toolbar button[data-h]").forEach(x=>x.classList.remove("active"));
        b.classList.add("active");
        this.setRangeHours(+b.dataset.h);
        this.refresh(); Overpass.refresh();
      };
    });
    document.getElementById("apply-range").onclick = ()=>{
      const f = document.getElementById("date-from").value, t = document.getElementById("date-to").value;
      if(!f||!t) return;
      let from = new Date(f+"T00:00:00").getTime(), to = new Date(t+"T23:59:59").getTime();
      if (to-from > CONFIG.maxCustomDays*864e5){ alert(`Période limitée à ${CONFIG.maxCustomDays} jours.`); return; }
      document.querySelectorAll(".toolbar button[data-h]").forEach(x=>x.classList.remove("active"));
      this.from = from; this.to = Math.min(to, Date.now());
      this.refresh(); Overpass.refresh();
    };
    document.getElementById("toggle-history").onchange = ()=>this.render();
    document.getElementById("reset-zoom").onclick = ()=>this.chart.resetZoom();

    const syncStrip = ({chart})=>Overpass.reposition(chart.scales.x.min, chart.scales.x.max);
    this.chart = new Chart(document.getElementById("levels-chart"), {
      type:"line", data:{datasets:[]},
      options:{
        responsive:true, maintainAspectRatio:false, animation:false, parsing:false, normalized:true,
        interaction:{mode:"nearest", axis:"x", intersect:false},
        onClick: (e)=>{
          const x = this.chart.scales.x.getValueForPixel(e.x);
          if (x) DateWind.show(new Date(x));
        },
        plugins:{
          legend:{labels:{color:"#8fa1bb", usePointStyle:true, pointStyle:"line",
            filter: item => !item.text.startsWith("_")}},
          tooltip:{callbacks:{label:c=>`${c.dataset.label.replace(/^_/,"")}: ${c.parsed.y?.toFixed(2)} m`}},
          zoom:{
            pan:{enabled:true, mode:"x", onPanComplete:syncStrip},
            zoom:{wheel:{enabled:true}, pinch:{enabled:true},
              drag:{enabled:true, modifierKey:"shift", backgroundColor:"rgba(63,182,255,.15)"},
              mode:"x", onZoomComplete:syncStrip},
            limits:{x:{min:"original", max:"original"}}
          }
        },
        scales:{
          x:{type:"time", time:{tooltipFormat:"dd LLL yyyy HH:mm"},
             ticks:{color:"#8fa1bb", maxTicksLimit:10, maxRotation:0}, grid:{color:"#243149"}},
          y:{position:"left", title:{display:true, text:"Niveau (m) — zéro des cartes", color:"#8fa1bb"},
             ticks:{color:"#8fa1bb"}, grid:{color:"#243149"}},
          y2:{position:"right", title:{display:true, text:"Lanoraie (m) — géodésique", color:"#ffb454"},
             ticks:{color:"#ffb454"}, grid:{drawOnChartArea:false}}
        }
      }
    });
  },
  async refresh(){
    const kpis = document.getElementById("kpis");
    const stations = CONFIG.waterStations;
    // séries courantes
    const cur = await Promise.allSettled(stations.map(st=>seriesFor(st, this.from, this.to)));
    // séries des années précédentes (décalées vers la fenêtre courante)
    const years = [...Array(CONFIG.historyYears)].map((_,i)=>i+1);
    const hist = await Promise.allSettled(stations.flatMap(st=>years.map(async k=>{
      const shift = k*365.25*864e5;
      const pts = await seriesFor(st, this.from-shift, this.to-shift, true);
      return { st, k, pts: pts.map(p=>({x:p.x+shift, y:p.y})) };
    })));
    this.data = {}; this.histData = {};
    kpis.innerHTML = "";
    cur.forEach((res,i)=>{
      const st = stations[i];
      const el = document.createElement("div"); el.className="kpi";
      el.onclick = ()=>window._map?.flyTo({center:[st.lon,st.lat],zoom:11});
      if (res.status!=="fulfilled" || !res.value.length){
        el.innerHTML = `<div class="name">${st.name}</div><div class="err">Données indisponibles</div>`;
      } else {
        const pts = res.value; this.data[st.key]=pts;
        const last = pts[pts.length-1];
        const ago6 = pts.find(p=>last.x - p.x <= 6*36e5) ?? pts[0];
        const delta = last.y - ago6.y;
        const cls = Math.abs(delta)<0.02?"flat":delta>0?"up":"down";
        el.innerHTML = `
          <div class="name">${st.name}</div>
          <div class="val" style="color:${st.color}">${last.y.toFixed(2)} <small>m</small>
            <span class="trend ${cls}">${cls==="flat"?"→":delta>0?"↑":"↓"} ${Math.abs(delta).toFixed(2)} m/6h</span></div>
          <div class="meta">${st.datum} · ${new Date(last.x).toLocaleString("fr-CA",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>`;
        window._updateMarker?.(st.key,last);
      }
      kpis.appendChild(el);
    });
    hist.forEach(res=>{
      if (res.status!=="fulfilled" || !res.value.pts.length) return;
      const {st,k,pts} = res.value;
      (this.histData[st.key] ??= {})[k] = pts;
    });
    this.render();
  },
  render(){
    const showHist = document.getElementById("toggle-history").checked;
    const ds = [];
    for (const st of CONFIG.waterStations){
      const pts = this.data[st.key]; if(!pts) continue;
      ds.push({label:st.name, data:pts, borderColor:st.color, backgroundColor:st.color,
        borderWidth:1.8, pointRadius:0, tension:.2, spanGaps:true, yAxisID:st.axis});
      if (showHist && this.histData[st.key]){
        const yearSets = Object.entries(this.histData[st.key]);
        for (const [k,hp] of yearSets){
          ds.push({label:`_${st.name} −${k} an${k>1?"s":""}`, data:hp, borderColor:"rgba(90,106,132,.55)",
            borderWidth:1, pointRadius:0, tension:.2, spanGaps:true, yAxisID:st.axis});
        }
        // moyenne des années précédentes (grille commune de 200 pts)
        if (yearSets.length){
          const N=200, grid=[...Array(N)].map((_,i)=>this.from + i*(this.to-this.from)/(N-1));
          const mean = grid.map(t=>{
            const vals = yearSets.map(([_,hp])=>{
              let best=null,bd=Infinity;
              for(const p of hp){const d=Math.abs(p.x-t); if(d<bd){bd=d;best=p;}}
              return best && bd < 2*864e5 ? best.y : null;
            }).filter(v=>v!=null);
            return {x:t, y: vals.length? vals.reduce((a,b)=>a+b)/vals.length : null};
          });
          ds.push({label:`${st.name} — moyenne ${CONFIG.historyYears} ans`, data:mean,
            borderColor:st.color+"99", borderDash:[6,4], borderWidth:1.4,
            pointRadius:0, spanGaps:true, yAxisID:st.axis});
        }
      }
    }
    this.chart.data.datasets = ds;
    this.chart.options.scales.x.min = this.from;
    this.chart.options.scales.x.max = this.to;
    this.chart.update();
    this.chart.resetZoom?.();
    Overpass.reposition(this.from, this.to);
  }
};
App.register(Levels);

/* ============================================================
   MODULE : Vent à une date précise (clic sur le graphique)
   Archives climatiques horaires ECCC
   ============================================================ */
const DateWind = {
  async show(date){
    const panel = document.getElementById("date-wind");
    panel.classList.add("open");
    const dstr = date.toLocaleString("fr-CA",{dateStyle:"medium",timeStyle:"short"});
    panel.innerHTML = `Vent le <b>${dstr}</b> : chargement…`;
    const rows = await Promise.all(CONFIG.climateStations.map(async cs=>{
      try{
        const local = new Date(date); local.setMinutes(0,0,0);
        const ld = local.toISOString().slice(0,10)+" "+String(local.getHours()).padStart(2,"0")+":00:00";
        const d = await fetchJSON(`https://api.weather.gc.ca/collections/climate-hourly/items?f=json&CLIMATE_IDENTIFIER=${cs.id}&LOCAL_DATE=${encodeURIComponent(ld)}&limit=1&properties=WIND_SPEED,WIND_DIRECTION,TEMP`);
        const p = d.features?.[0]?.properties;
        if(!p) return `${cs.name} : aucune donnée archivée`;
        return `<b>${cs.name}</b> : ${p.WIND_SPEED!=null?p.WIND_SPEED+" km/h":"–"}` +
          (p.WIND_DIRECTION!=null?` · ${p.WIND_DIRECTION*10}°`:"") +
          (p.TEMP!=null?` · ${p.TEMP} °C`:"");
      }catch(e){ return `${cs.name} : erreur (${e.message})`; }
    }));
    panel.innerHTML = `Vent le <b>${dstr}</b> (archives horaires ECCC) — ${rows.join(" &nbsp;|&nbsp; ")}
      <span style="float:right;cursor:pointer;color:var(--muted)" onclick="this.parentElement.classList.remove('open')">✕</span>`;
  }
};

/* ============================================================
   MODULE : Passages satellites (STAC Earth Search + Planet)
   ============================================================ */
const Overpass = {
  items: [], planetError: null,
  async refresh(){
    this.items = [];
    this.planetError = null;
    const dt = `${iso(Levels.from)}/${iso(Levels.to)}`;
    await Promise.allSettled(CONFIG.satellites.filter(s=>s.stac).map(async sat=>{
      const d = await fetchJSON(`${CONFIG.stacApi}?collections=${sat.stac}&bbox=${CONFIG.lakeBbox.join(",")}&datetime=${dt}&limit=100`);
      for (const f of d.features||[]){
        this.items.push({ sat, id:f.id, time:new Date(f.properties.datetime).getTime(),
          cloud: f.properties["eo:cloud_cover"],
          thumb: f.assets?.thumbnail?.href || f.assets?.rendered_preview?.href || null,
          selfUrl: f.links?.find(l=>l.rel==="self")?.href });
      }
    }));
    if (CONFIG.planetApiKey) await this.fetchPlanet(dt).catch(e=>{ this.planetError = e.message; });
    this.renderLegend();
    this.reposition(Levels.from, Levels.to);
  },
  // Planet Data API — quick-search des PSScene (SuperDoves)
  async fetchPlanet(dt){
    const sat = CONFIG.satellites.find(s=>s.key==="planet");
    const [t0,t1] = dt.split("/");
    const [w,s,e,n] = CONFIG.lakeBbox;
    const r = await fetch("https://api.planet.com/data/v1/quick-search", {
      method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":"api-key "+CONFIG.planetApiKey },
      body: JSON.stringify({
        item_types:["PSScene"],
        filter:{ type:"AndFilter", config:[
          { type:"GeometryFilter", field_name:"geometry",
            config:{ type:"Polygon", coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]] } },
          { type:"DateRangeFilter", field_name:"acquired", config:{ gte:t0, lte:t1 } }
        ]}
      })
    });
    if (r.status===401 || r.status===403) throw new Error("clé refusée");
    if (!r.ok) throw new Error("HTTP "+r.status);
    const d = await r.json();
    for (const f of d.features||[]){
      this.items.push({ sat, id:f.id, time:new Date(f.properties.acquired).getTime(),
        cloud: f.properties.cloud_percent ?? (f.properties.cloud_cover!=null ? f.properties.cloud_cover*100 : null),
        thumb: f._links?.thumbnail ? f._links.thumbnail+"?api_key="+CONFIG.planetApiKey : null,
        selfUrl: f._links?._self });
    }
  },
  renderLegend(){
    const legend = document.getElementById("op-legend");
    legend.innerHTML = CONFIG.satellites.filter(s=>!s.requiresKey).map(s=>
      `<span style="color:${s.color}">${s.name}</span>`).join("");
    const planet = CONFIG.satellites.find(s=>s.requiresKey);
    const chip = document.createElement("span");
    chip.style.color = planet.color; chip.style.cursor = "pointer";
    if (CONFIG.planetApiKey){
      const n = this.items.filter(i=>i.sat===planet).length;
      chip.innerHTML = this.planetError
        ? `${planet.name} — erreur : ${this.planetError} (cliquer pour reconfigurer)`
        : `${planet.name} ✓ connecté (${n} scènes) — cliquer pour déconnecter`;
      chip.onclick = ()=>{
        if (this.planetError) this.connectPlanet();
        else if (confirm("Déconnecter Planet et oublier la clé API ?")){
          localStorage.removeItem("planetApiKey"); this.refresh();
        }
      };
    } else {
      chip.textContent = `⊕ Connecter ${planet.name}`;
      chip.onclick = ()=>this.connectPlanet();
    }
    legend.appendChild(chip);
  },
  connectPlanet(){
    document.getElementById("modal-content").innerHTML = `
      <h3 style="margin-bottom:6px">Connecter Planet (SuperDoves)</h3>
      <div class="sub" style="margin-bottom:10px">Entrez votre clé API Planet
        (<a href="https://www.planet.com/account/#/user-settings" target="_blank" style="color:var(--accent)">mon compte ↗</a>).
        Elle est conservée uniquement dans ce navigateur (localStorage) et envoyée directement à api.planet.com.</div>
      <input type="password" id="planet-key-input" placeholder="PLAK…" style="width:100%;padding:8px;border-radius:8px;
        border:1px solid var(--border);background:var(--panel2);color:var(--text)">
      <div class="links"><button class="btn" id="planet-key-save">Connecter</button></div>
      <div class="sub" id="planet-key-msg" style="margin-top:8px"></div>`;
    document.getElementById("modal").classList.add("open");
    document.getElementById("planet-key-save").onclick = async ()=>{
      const key = document.getElementById("planet-key-input").value.trim();
      if(!key) return;
      const msg = document.getElementById("planet-key-msg");
      msg.textContent = "Vérification…";
      localStorage.setItem("planetApiKey", key);
      try{
        await this.fetchPlanet(`${iso(Date.now()-7*864e5)}/${iso(Date.now())}`);
        msg.textContent = "Connecté ✓";
        document.getElementById("modal").classList.remove("open");
        this.refresh();
      }catch(e){
        localStorage.removeItem("planetApiKey");
        msg.innerHTML = `<span class="err">Échec : ${e.message}. Vérifiez la clé (ou blocage CORS du réseau).</span>`;
      }
    };
  },
  reposition(minX, maxX){
    const strip = document.getElementById("overpass-strip");
    strip.querySelectorAll(".op-dot,.lane-label").forEach(e=>e.remove());
    CONFIG.satellites.forEach(s=>{
      const lbl = document.createElement("span");
      lbl.className="lane-label"; lbl.style.top=(s.lane-6)+"px"; lbl.textContent=s.name;
      strip.appendChild(lbl);
    });
    for (const it of this.items){
      if (it.time < minX || it.time > maxX) continue;
      const dot = document.createElement("div");
      dot.className="op-dot";
      dot.style.left = (100*(it.time-minX)/(maxX-minX))+"%";
      dot.style.top = it.sat.lane+"px";
      dot.style.background = it.sat.color;
      dot.title = `${it.sat.name} · ${new Date(it.time).toLocaleString("fr-CA")}${it.cloud!=null?` · nuages ${Math.round(it.cloud)}%`:""}`;
      dot.onclick = ()=>this.preview(it);
      strip.appendChild(dot);
    }
  },
  preview(it){
    const d = dayStr(it.time);
    document.getElementById("modal-content").innerHTML = `
      <h3 style="margin-bottom:4px">${it.sat.name}</h3>
      <div class="sub" style="margin-bottom:10px">${it.id}<br>
        ${new Date(it.time).toLocaleString("fr-CA")}${it.cloud!=null?` · couverture nuageuse ${Math.round(it.cloud)} %`:""}</div>
      ${it.thumb?`<img src="${it.thumb}" alt="aperçu" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'sub',textContent:'Aperçu non disponible'}))">`:`<div class="sub">Aperçu non disponible</div>`}
      <div class="links">
        ${it.sat.external?`<a href="${it.sat.external(d)}" target="_blank">Ouvrir dans le visualiseur externe ↗</a>`:""}
        ${it.selfUrl?`<a href="${it.selfUrl}" target="_blank">Métadonnées STAC ↗</a>`:""}
      </div>`;
    document.getElementById("modal").classList.add("open");
  },
  init(){ /* rendu déclenché après Levels */ }
};
App.register(Overpass);

/* ============================================================
   MODULE : Vent temps réel (SWOB, repli Open-Meteo)
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
            <div class="detail">${o.dir!=null?`${this.dirName(dir)} (${Math.round(dir)}°) · `:""}${o.temp!=null?o.temp.toFixed(1)+" °C · ":""}${o.time.toLocaleTimeString("fr-CA",{hour:"2-digit",minute:"2-digit"})}</div>
          </div>
        </div>`);
      if (o.speed!=null) window._updateWind?.(o);
    });
  },
  dirName(d){ return ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSO","SO","OSO","O","ONO","NO","NNO"][Math.round(d/22.5)%16]; }
});

/* ============================================================
   MODULE : Carte MapLibre + couches WMS
   ============================================================ */
App.register({
  markers:{}, windMarkers:{},
  async init(){
    const map = new maplibregl.Map({
      container:"map",
      style:{ version:8,
        sources:{ osm:{type:"raster", tiles:["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize:256, attribution:"© OpenStreetMap"} },
        layers:[ {id:"bg",type:"background",paint:{"background-color":"#0d1420"}},
          {id:"osm",type:"raster",source:"osm",paint:{"raster-opacity":0.85,"raster-saturation":-0.5,"raster-brightness-max":0.7}} ] },
      center:CONFIG.map.center, zoom:CONFIG.map.zoom
    });
    map.addControl(new maplibregl.NavigationControl(),"top-right");
    map.addControl(new maplibregl.ScaleControl());
    window._map = map;
    map.on("load", ()=>{
      const togglesEl = document.getElementById("layer-toggles");
      CONFIG.overlays.forEach(ov=>{
        map.addSource(ov.key,{type:"raster",tiles:[ov.tiles],tileSize:256});
        map.addLayer({id:ov.key,type:"raster",source:ov.key,
          layout:{visibility:ov.visible?"visible":"none"},paint:{"raster-opacity":ov.opacity}});
        const lbl = document.createElement("label");
        lbl.innerHTML = `<input type="checkbox" ${ov.visible?"checked":""}> ${ov.name}`;
        lbl.querySelector("input").onchange = e =>
          map.setLayoutProperty(ov.key,"visibility",e.target.checked?"visible":"none");
        togglesEl.appendChild(lbl);
      });
    });
    CONFIG.waterStations.forEach(st=>{
      const el = document.createElement("div");
      el.style.cssText = `width:16px;height:16px;border-radius:50%;background:${st.color};border:2.5px solid #0d1420;box-shadow:0 0 8px ${st.color}`;
      const popup = new maplibregl.Popup({offset:14}).setHTML(`<b>${st.name}</b><br>Chargement…`);
      this.markers[st.key] = { popup, st,
        marker:new maplibregl.Marker({element:el}).setLngLat([st.lon,st.lat]).setPopup(popup).addTo(map) };
    });
    window._updateMarker = (key,last)=>{
      const m = this.markers[key]; if(!m) return;
      m.popup.setHTML(`<b>${m.st.name}</b><br>Niveau : <b>${last.y.toFixed(2)} m</b> (${m.st.datum})<br>` +
        new Date(last.x).toLocaleString("fr-CA",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}));
    };
    window._updateWind = (o)=>{
      const key = o.name;
      if (!this.windMarkers[key]){
        const el = document.createElement("div");
        this.windMarkers[key] = { el, marker:new maplibregl.Marker({element:el}).setLngLat([o.lon,o.lat]).addTo(map) };
      }
      this.windMarkers[key].el.innerHTML =
        `<svg width="34" height="34" viewBox="0 0 34 34" style="opacity:.9">
           <g transform="rotate(${(o.dir??0)+180},17,17)"><path d="M17 4 L22 24 L17 19 L12 24 Z" fill="#3fb6ff" stroke="#0d1420" stroke-width="1"/></g>
           <text x="17" y="32" fill="#e8eef7" font-size="8" text-anchor="middle" font-family="sans-serif">${Math.round(o.speed)}</text></svg>`;
    };
  }
});

/* ============================================================
   MODULE : Export des données
   ============================================================ */
const Exporter = {
  collect(){
    const rows = [];
    for (const st of CONFIG.waterStations)
      for (const p of Levels.data[st.key]||[])
        rows.push({type:"niveau_eau", station:st.name, datum:st.datum, time:iso(p.x), value:p.y, unit:"m"});
    for (const [key,years] of Object.entries(Levels.histData))
      for (const [k,pts] of Object.entries(years)){
        const st = CONFIG.waterStations.find(s=>s.key===key);
        for (const p of pts) rows.push({type:`niveau_eau_-${k}an`, station:st.name, datum:st.datum, time:iso(p.x), value:p.y, unit:"m"});
      }
    for (const o of window._windData||[])
      rows.push({type:"vent", station:o.name, datum:"", time:iso(o.time), value:o.speed, unit:"km/h", extra:`dir=${o.dir};rafales=${o.gust};temp=${o.temp}`});
    for (const it of Overpass.items)
      rows.push({type:"passage_satellite", station:it.sat.name, datum:"", time:iso(it.time), value:it.cloud, unit:"%nuages", extra:it.id});
    return rows;
  },
  download(blob,name){
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    URL.revokeObjectURL(a.href);
  },
  csv(){
    const rows = this.collect();
    const head = ["type","station","datum","time","value","unit","extra"];
    const csv = [head.join(",")].concat(rows.map(r=>head.map(h=>`"${(r[h]??"").toString().replace(/"/g,'""')}"`).join(","))).join("\n");
    this.download(new Blob(["﻿"+csv],{type:"text/csv;charset=utf-8"}), `lac-saint-pierre_${dayStr(Date.now())}.csv`);
  },
  json(){
    this.download(new Blob([JSON.stringify({exported:iso(Date.now()), window:{from:iso(Levels.from), to:iso(Levels.to)}, data:this.collect()},null,1)],
      {type:"application/json"}), `lac-saint-pierre_${dayStr(Date.now())}.json`);
  }
};

App.init();
