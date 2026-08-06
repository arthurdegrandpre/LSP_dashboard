/* ============================================================
   MODULE PRINCIPAL : séries temporelles (niveaux d'eau + vent)
   et export des données.

   Le catalogue des séries est construit à partir de la configuration
   AVANT tout appel réseau ; seules les séries cochées dans le panneau
   latéral sont réellement téléchargées. C'est ce qui permet d'offrir
   des dizaines de séries sans saturer les API.
   ============================================================ */

/* ---------- sources de niveaux d'eau ---------- */

// IWLS — résolution adaptative : minute (fenêtre courte) ou horaire (fenêtre longue)
async function iwlsSeries(id, fromMs, toMs){
  const spanDays = (toMs-fromMs)/864e5;
  const hourly = spanDays > 21;
  const chunk = (hourly ? 30*24 : 48)*36e5;
  const res = hourly ? "&resolution=SIXTY_MINUTES" : "";
  const reqs = [];
  for (let t = fromMs; t < toMs; t += chunk){
    reqs.push(fetchJSON(`https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${id}/data?time-series-code=wlo&from=${iso(t)}&to=${iso(Math.min(t+chunk, toMs))}${res}`)
      .catch(()=>[]));
  }
  const out = (await Promise.all(reqs)).flat();
  return subsample(out.map(p=>({x:new Date(p.eventDate).getTime(), y:p.value})));
}
// ECCC temps réel (~1 mois d'archive)
async function geometRealtime(id, fromMs, toMs){
  const d = await fetchJSON(`https://api.weather.gc.ca/collections/hydrometric-realtime/items?f=json&STATION_NUMBER=${id}&datetime=${iso(fromMs)}/${iso(toMs)}&limit=8000&properties=DATETIME,LEVEL&sortby=DATETIME`);
  return subsample(d.features.map(f=>({x:new Date(f.properties.DATETIME).getTime(), y:f.properties.LEVEL})).filter(p=>p.y!=null));
}
// ECCC moyennes journalières historiques (HYDAT)
async function geometDaily(id, fromMs, toMs){
  const d = await fetchJSON(`https://api.weather.gc.ca/collections/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${id}&datetime=${iso(fromMs)}/${iso(toMs)}&limit=1000&properties=DATE,LEVEL&sortby=DATE`);
  return d.features.map(f=>({x:new Date(f.properties.DATE+"T12:00:00Z").getTime(), y:f.properties.LEVEL})).filter(p=>p.y!=null);
}
// Lanoraie : le temps réel ne couvre qu'~1 mois — combiner archives journalières + temps réel
async function geometCombined(id, fromMs, toMs){
  const cut = Date.now() - 29*864e5;
  if (fromMs >= cut) return geometRealtime(id, fromMs, toMs).then(p=>p.length?p:geometDaily(id,fromMs,toMs));
  const [daily, rt] = await Promise.all([
    geometDaily(id, fromMs, Math.min(toMs, cut)),
    toMs > cut ? geometRealtime(id, cut, toMs) : Promise.resolve([])
  ]);
  return daily.concat(rt);
}
const seriesFor = (st, fromMs, toMs, historical=false) =>
  st.type==="iwls" ? iwlsSeries(st.id, fromMs, toMs)
  : historical ? geometDaily(st.id, fromMs, toMs) : geometCombined(st.id, fromMs, toMs);

const YEAR_MS = 365.25*864e5;

/* ============================================================
   MODULE : graphique des séries temporelles
   ============================================================ */
const Levels = {
  chart:null, from:null, to:null,
  data:{},       // niveaux courants     : clé station -> points {x,y}
  histData:{},   // niveaux années préc. : clé station -> { k: points }
  windData:{},   // vent courant         : clé station -> points {x,speed,dir,gust,temp}
  windHist:{},   // vent années préc.    : clé station -> { k: points }
  cache:new Map(),

  setRangeHours(h){ this.to = Date.now(); this.from = this.to - h*36e5; this.cache.clear(); },
  setRange(from, to){ this.from = from; this.to = to; this.cache.clear(); },

  async init(){
    this.setRangeHours(72);
    SeriesPanel.init();
    SeriesPanel.onChange = ()=>this.refresh();

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
      const from = new Date(f+"T00:00:00").getTime(), to = new Date(t+"T23:59:59").getTime();
      if (to-from > CONFIG.maxCustomDays*864e5){ alert(`Période limitée à ${CONFIG.maxCustomDays} jours.`); return; }
      document.querySelectorAll(".toolbar button[data-h]").forEach(x=>x.classList.remove("active"));
      this.setRange(from, Math.min(to, Date.now()));
      this.refresh(); Overpass.refresh();
    };
    document.getElementById("reset-zoom").onclick = ()=>{ this.chart.resetZoom(); };

    // défilement latéral : si la vue dépasse les données chargées, on étend la fenêtre
    const onViewChange = ({chart})=>{
      const {min,max} = chart.scales.x;
      Overpass.reposition(min,max);
      if (min < this.from || max > this.to) this.extend(min,max);
    };
    this.chart = new Chart(document.getElementById("levels-chart"), {
      type:"line", data:{datasets:[]},
      options:{
        responsive:true, maintainAspectRatio:false, animation:false, parsing:false, normalized:true,
        interaction:{mode:"nearest", axis:"x", intersect:false},
        onClick: (e)=>{
          const x = this.chart.scales.x.getValueForPixel(e.x);
          if (x) MetWidget.show(x, true);
        },
        onHover: (e)=>{
          const x = this.chart.scales.x.getValueForPixel(e.x);
          if (x) MetWidget.show(x, false);
        },
        plugins:{
          // la légende Chart.js est remplacée par le panneau latéral :
          // elle devient illisible dès qu'on dépasse une dizaine de séries
          legend:{ display:false },
          tooltip:{ callbacks:{
            label:c=>`${c.dataset.label}: ${c.parsed.y?.toFixed(c.dataset.unit==="km/h"?0:2)} ${c.dataset.unit||"m"}` } },
          zoom:{
            pan:{enabled:true, mode:"x", onPanComplete:onViewChange},
            zoom:{wheel:{enabled:true}, pinch:{enabled:true},
              drag:{enabled:true, modifierKey:"shift", backgroundColor:"rgba(63,182,255,.15)"},
              mode:"x", onZoomComplete:onViewChange}
          }
        },
        scales:{
          x:{type:"time", time:{tooltipFormat:"dd LLL yyyy HH:mm"},
             ticks:{color:"#8fa1bb", maxTicksLimit:10, maxRotation:0}, grid:{color:"#243149"}},
          y:{position:"left", title:{display:true, text:"Niveau (m) — zéro des cartes", color:"#8fa1bb"},
             ticks:{color:"#8fa1bb"}, grid:{color:"#243149"}},
          y2:{position:"right", display:false,
             title:{display:true, text:"Lanoraie (m) — géodésique", color:"#ffb454"},
             ticks:{color:"#ffb454"}, grid:{drawOnChartArea:false}},
          yw:{position:"right", display:false, beginAtZero:true,
             title:{display:true, text:"Vent (km/h)", color:"#7ecbff"},
             ticks:{color:"#7ecbff"}, grid:{drawOnChartArea:false}}
        }
      }
    });
    this.buildCatalog();
    SeriesPanel.render();
  },

  /* ---------- catalogue des séries (aucun appel réseau) ---------- */
  buildCatalog(){
    const spanDays = (this.to-this.from)/864e5;
    const histOff = spanDays > CONFIG.histMaxDays;
    const why = `Désactivé au-delà de ${CONFIG.histMaxDays} jours (volume de données)`;
    SeriesPanel.reset();

    for (const st of CONFIG.waterStations){
      const g = "lvl:"+st.key;
      SeriesPanel.declare(`lvl:${st.key}`, { group:g, groupLabel:st.name, groupColor:st.color,
        label:"Niveau", color:st.color, kind:"level", def:true });
      for (let k=1; k<=CONFIG.historyYears; k++)
        SeriesPanel.declare(`lvl:${st.key}:y${k}`, { group:g, label:`Niveau −${k} an${k>1?"s":""}`,
          color:"#5a6a84", kind:"hist", def:false, disabled:histOff, disabledReason:why });
      SeriesPanel.declare(`lvl:${st.key}:mean`, { group:g, label:`Moyenne ${CONFIG.historyYears} ans`,
        color:st.color, dash:"dash", kind:"mean", def:true, disabled:histOff, disabledReason:why });
    }
    for (const ws of CONFIG.windSeries){
      const g = "wnd:"+ws.key;
      SeriesPanel.declare(`wnd:${ws.key}`, { group:g, groupLabel:ws.name+" — vent", groupColor:ws.color,
        label:"Vitesse du vent", color:ws.color, kind:"wind", def:!!ws.met });
      SeriesPanel.declare(`wnd:${ws.key}:gust`, { group:g, label:"Rafales", color:ws.color,
        dash:"dot", kind:"gust", def:false });
      for (let k=1; k<=CONFIG.historyYears; k++)
        SeriesPanel.declare(`wnd:${ws.key}:y${k}`, { group:g, label:`Vent −${k} an${k>1?"s":""}`,
          color:"#5a6a84", kind:"windhist", def:false, disabled:histOff, disabledReason:why });
    }
  },

  /* mémorisation par (série, fenêtre) : cocher / décocher ne retélécharge rien */
  cached(id, fn){
    const k = `${id}|${this.from}|${this.to}`;
    if (!this.cache.has(k)) this.cache.set(k, Promise.resolve().then(fn).catch(()=>[]));
    return this.cache.get(k);
  },

  busy(on){ document.getElementById("chart-card")?.classList.toggle("busy", !!on); },

  // extension paresseuse quand on défile au-delà des données chargées
  extend(min, max){
    clearTimeout(this._extT);
    this._extT = setTimeout(()=>{
      const span = this.to - this.from;
      let from = this.from, to = this.to;
      if (min < this.from) from = Math.max(min - span*0.5, Date.now() - 5*YEAR_MS);
      if (max > this.to)   to   = Math.min(max + span*0.5, Date.now());
      this.setRange(from, to);
      this.refresh({min, max}); Overpass.refresh();
    }, 350);
  },

  /* ---------- chargement ---------- */
  async refresh(keepView){
    // compteur de génération : en cochant plusieurs séries à la suite, un
    // chargement lancé plus tôt peut se terminer plus tard — on l'ignore
    // alors plutôt que d'écraser l'état courant avec un état périmé.
    const gen = ++this._gen;
    this.buildCatalog();
    SeriesPanel.render();
    this.busy(true);
    let levels, wind;
    try { [levels, wind] = await Promise.all([ this.loadLevels(), this.loadWind() ]); }
    finally { if (gen === this._gen) this.busy(false); }
    if (gen !== this._gen) return;          // une demande plus récente a pris le relais
    this.data = levels.data; this.histData = levels.hist;
    this.windData = wind.data; this.windHist = wind.hist;
    this.renderKpis();
    this.render(keepView);
    MetWidget.redraw();
  },
  _gen: 0,

  async loadLevels(){
    const stations = CONFIG.waterStations;
    // les niveaux courants sont toujours chargés : ils alimentent les KPI et la carte
    const cur = await Promise.allSettled(stations.map(st=>
      this.cached(`lvl:${st.key}`, ()=>seriesFor(st, this.from, this.to))));
    const data = {};
    cur.forEach((r,i)=>{ if (r.status==="fulfilled" && r.value?.length) data[stations[i].key] = r.value; });

    // années précédentes : uniquement si la courbe ou la moyenne est cochée
    const jobs = [];
    for (const st of stations){
      const wantMean = SeriesPanel.on(`lvl:${st.key}:mean`);
      for (let k=1; k<=CONFIG.historyYears; k++){
        if (!wantMean && !SeriesPanel.on(`lvl:${st.key}:y${k}`)) continue;
        jobs.push(this.cached(`lvl:${st.key}:y${k}`, async ()=>{
          const shift = k*YEAR_MS;
          const pts = await seriesFor(st, this.from-shift, this.to-shift, true);
          return pts.map(p=>({x:p.x+shift, y:p.y}));
        }).then(pts=>({st,k,pts})).catch(()=>null));
      }
    }
    const hist = {};
    for (const r of await Promise.all(jobs)){
      if (!r?.pts?.length) continue;
      (hist[r.st.key] ??= {})[r.k] = r.pts;
    }
    return { data, hist };
  },

  async loadWind(){
    const jobs = [];
    for (const ws of CONFIG.windSeries){
      const wantSpeed = SeriesPanel.on(`wnd:${ws.key}`);
      const wantGust  = SeriesPanel.on(`wnd:${ws.key}:gust`);
      // ws.met : série de référence du widget météo, toujours chargée
      if (wantSpeed || wantGust || ws.met)
        jobs.push(this.cached(`wnd:${ws.key}${wantGust?":g":""}`,
          ()=>WindData.series(ws, this.from, this.to, {needGust:wantGust}))
          .then(pts=>({ws, k:0, pts})).catch(()=>null));
      for (let k=1; k<=CONFIG.historyYears; k++){
        if (!SeriesPanel.on(`wnd:${ws.key}:y${k}`)) continue;
        jobs.push(this.cached(`wnd:${ws.key}:y${k}`, async ()=>{
          const shift = k*YEAR_MS;
          const pts = await WindData.series(ws, this.from-shift, this.to-shift);
          return pts.map(p=>({...p, x:p.x+shift}));
        }).then(pts=>({ws, k, pts})).catch(()=>null));
      }
    }
    const data = {}, hist = {};
    for (const r of await Promise.all(jobs)){
      if (!r?.pts?.length) continue;
      if (r.k === 0) data[r.ws.key] = r.pts;
      else (hist[r.ws.key] ??= {})[r.k] = r.pts;
    }
    return { data, hist };
  },

  /* ---------- KPI ---------- */
  renderKpis(){
    const kpis = document.getElementById("kpis");
    kpis.innerHTML = "";
    for (const st of CONFIG.waterStations){
      const el = document.createElement("div"); el.className="kpi";
      el.onclick = ()=>window._map?.flyTo({center:[st.lon,st.lat],zoom:11});
      const pts = this.data[st.key];
      if (!pts?.length){
        el.innerHTML = `<div class="name">${st.name}</div><div class="err">Données indisponibles</div>`;
      } else {
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
    }
  },

  /* ---------- tracé ---------- */
  render(keepView){
    const ds = [];
    let useY2 = false, useYw = false;

    for (const st of CONFIG.waterStations){
      const pts = this.data[st.key];
      if (pts && SeriesPanel.on(`lvl:${st.key}`)){
        ds.push({label:st.name, data:pts, borderColor:st.color, backgroundColor:st.color,
          borderWidth:1.8, pointRadius:0, tension:.2, spanGaps:true, yAxisID:st.axis, unit:"m"});
        if (st.axis === "y2") useY2 = true;
      }
      const years = this.histData[st.key] || {};
      for (const [k,hp] of Object.entries(years)){
        if (!SeriesPanel.on(`lvl:${st.key}:y${k}`)) continue;
        ds.push({label:`${st.name} −${k} an${k>1?"s":""}`, data:hp, borderColor:"rgba(90,106,132,.55)",
          borderWidth:1, pointRadius:0, tension:.2, spanGaps:true, yAxisID:st.axis, unit:"m"});
        if (st.axis === "y2") useY2 = true;
      }
      if (SeriesPanel.on(`lvl:${st.key}:mean`)){
        const mean = this.meanOfYears(Object.values(years), p=>p.y);
        if (mean){
          ds.push({label:`${st.name} — moyenne ${CONFIG.historyYears} ans`, data:mean,
            borderColor:st.color+"99", borderDash:[6,4], borderWidth:1.4,
            pointRadius:0, spanGaps:true, yAxisID:st.axis, unit:"m"});
          if (st.axis === "y2") useY2 = true;
        }
      }
    }

    for (const ws of CONFIG.windSeries){
      const pts = this.windData[ws.key];
      if (pts?.length && SeriesPanel.on(`wnd:${ws.key}`)){
        ds.push({label:`${ws.name} — vent`, unit:"km/h", yAxisID:"yw",
          data:pts.filter(p=>p.speed!=null).map(p=>({x:p.x, y:p.speed})),
          borderColor:ws.color, borderWidth:1.4, pointRadius:0, tension:.25, spanGaps:true});
        useYw = true;
      }
      if (pts?.length && SeriesPanel.on(`wnd:${ws.key}:gust`)){
        const g = pts.filter(p=>p.gust!=null).map(p=>({x:p.x, y:p.gust}));
        if (g.length){
          ds.push({label:`${ws.name} — rafales`, unit:"km/h", yAxisID:"yw", data:g,
            borderColor:ws.color, borderDash:[2,3], borderWidth:1.2, pointRadius:0, spanGaps:true});
          useYw = true;
        }
      }
      for (const [k,hp] of Object.entries(this.windHist[ws.key] || {})){
        if (!SeriesPanel.on(`wnd:${ws.key}:y${k}`)) continue;
        ds.push({label:`${ws.name} — vent −${k} an${k>1?"s":""}`, unit:"km/h", yAxisID:"yw",
          data:hp.filter(p=>p.speed!=null).map(p=>({x:p.x, y:p.speed})),
          borderColor:"rgba(90,106,132,.5)", borderWidth:1, pointRadius:0, spanGaps:true});
        useYw = true;
      }
    }

    this.chart.options.scales.y2.display = useY2;
    this.chart.options.scales.yw.display = useYw;
    this.chart.data.datasets = ds;
    this.chart.options.scales.x.min = keepView?.min ?? this.from;
    this.chart.options.scales.x.max = keepView?.max ?? this.to;
    this.chart.update();
    Overpass.reposition(this.chart.options.scales.x.min, this.chart.options.scales.x.max);
  },

  /* moyenne des années précédentes sur une grille commune */
  meanOfYears(yearSets, pick){
    if (!yearSets.length) return null;
    const N = 200, grid = [...Array(N)].map((_,i)=>this.from + i*(this.to-this.from)/(N-1));
    return grid.map(t=>{
      const vals = yearSets.map(hp=>{
        let best=null, bd=Infinity;
        for (const p of hp){ const d=Math.abs(p.x-t); if(d<bd){ bd=d; best=p; } }
        return best && bd < 2*864e5 ? pick(best) : null;
      }).filter(v=>v!=null);
      return { x:t, y: vals.length ? vals.reduce((a,b)=>a+b)/vals.length : null };
    });
  }
};
App.register(Levels);

/* ============================================================
   MODULE : Export des données (CSV / JSON)
   Inclut les séries de vent (vitesse, direction, rafales, température)
   et les métriques de filtrage des scènes satellites.
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

    // séries de vent horaires (graphique)
    for (const ws of CONFIG.windSeries){
      const extra = p=>`dir=${p.dir ?? ""};rafales=${p.gust ?? ""};temp=${p.temp ?? ""}`;
      for (const p of Levels.windData[ws.key]||[])
        rows.push({type:"vent_serie", station:ws.name, datum:"", time:iso(p.x),
          value:p.speed, unit:"km/h", extra:extra(p)});
      for (const [k,pts] of Object.entries(Levels.windHist[ws.key]||{}))
        for (const p of pts)
          rows.push({type:`vent_serie_-${k}an`, station:ws.name, datum:"", time:iso(p.x),
            value:p.speed, unit:"km/h", extra:extra(p)});
    }

    // vent temps réel (cartes)
    for (const o of window._windData||[])
      rows.push({type:"vent_temps_reel", station:o.name, datum:"", time:iso(o.time), value:o.speed, unit:"km/h",
        extra:`dir=${o.dir ?? ""};rafales=${o.gust ?? ""};temp=${o.temp ?? ""}`});

    // scènes satellites retenues par les filtres
    for (const it of Overpass.visible())
      rows.push({type:"passage_satellite", station:it.sat.name, datum:"", time:iso(it.time),
        value:it.cloud, unit:"%nuages",
        extra:`id=${it.id};recouvrement=${it.overlap!=null?Math.round(it.overlap)+"%":""}`});
    return rows;
  },
  meta(){
    return {
      exported: iso(Date.now()),
      window: { from:iso(Levels.from), to:iso(Levels.to) },
      series_affichees: SeriesPanel.activeIds(),
      zone_interet: { description: Aoi.label(), geometry: Aoi.geometry() },
      filtres_scenes: Overpass.filters
    };
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
    this.download(new Blob([JSON.stringify(Object.assign(this.meta(), {data:this.collect()}),null,1)],
      {type:"application/json"}), `lac-saint-pierre_${dayStr(Date.now())}.json`);
  }
};

App.init();
/* fin */
