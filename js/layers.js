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
   MODULE : Qualité de l'eau — Réseau-Rivières (Données Québec, CKAN)
   Découvre les ressources du jeu de données, charge stations + dernières
   mesures dans la bbox, et les affiche sur la carte (losanges cyan).
   Échec réseau/CORS → statut « indisponible » sans casser l'app.
   ============================================================ */
const WaterQuality = {
  stations: [], markers: [], status: "chargement",
  async init(){
    await whenMap();
    this.load().catch(e=>{ this.status = "indisponible ("+e.message+")"; this.chip(); });
  },
  chip(){
    let el = document.getElementById("wq-chip");
    if (!el){
      el = document.createElement("label"); el.id = "wq-chip";
      document.getElementById("layer-toggles").appendChild(el);
    }
    if (this.stations.length){
      el.innerHTML = `<input type="checkbox" checked> Qualité de l'eau (${this.stations.length} stations)`;
      el.querySelector("input").onchange = e =>
        this.markers.forEach(m=>m.getElement().style.display = e.target.checked?"":"none");
    } else {
      el.textContent = `Qualité de l'eau : ${this.status}`;
    }
  },
  async load(){
    const wq = CONFIG.waterQuality;
    let geojson = null;
    if (wq.arcgisLayer){
      // Service ArcGIS REST du MELCCFP — requête GeoJSON filtrée par bbox (repli CKAN si échec)
      const [w,s,e,n] = wq.bbox;
      geojson = await fetchJSON(`${wq.arcgisLayer}/query?f=geojson&where=1%3D1&outFields=*` +
        `&geometry=${w},${s},${e},${n}&inSR=4326&outSR=4326&resultRecordCount=${wq.maxStations}`)
        .catch(()=>null);
    }
    if (!geojson && wq.geojsonUrl){
      geojson = await fetchJSON(wq.geojsonUrl);
    }
    if (!geojson){
      // découverte via l'API CKAN
      const pkg = await fetchJSON(`${wq.ckanBase}/package_show?id=${wq.datasetId}`);
      const resources = pkg.result?.resources || [];
      const geo = resources.find(r=>/geojson/i.test(r.format||"") && !/zip/i.test(r.url||""))
               || resources.find(r=>/json/i.test(r.format||""));
      if (geo) geojson = await fetchJSON(geo.url);
      else {
        // repli : ressource datastore (CSV indexé) — champs lat/long découverts dynamiquement
        const dsRes = resources.find(r=>r.datastore_active);
        if (!dsRes) throw new Error("aucune ressource exploitable");
        const meta = await fetchJSON(`${wq.ckanBase}/datastore_search?resource_id=${dsRes.id}&limit=0`);
        const fields = meta.result.fields.map(f=>f.id);
        const latF = fields.find(f=>/lat/i.test(f)), lonF = fields.find(f=>/lon|lng/i.test(f));
        if (!latF||!lonF) throw new Error("champs de coordonnées introuvables");
        const rows = (await fetchJSON(`${wq.ckanBase}/datastore_search?resource_id=${dsRes.id}&limit=5000`)).result.records;
        geojson = { features: rows.map(r=>({ geometry:{coordinates:[+r[lonF], +r[latF]]}, properties:r })) };
      }
    }
    const [w,s,e,n] = wq.bbox;
    const feats = (geojson.features||[]).filter(f=>{
      const c = f.geometry?.coordinates; return c && c[0]>=w && c[0]<=e && c[1]>=s && c[1]<=n;
    }).slice(0, wq.maxStations);
    if (!feats.length){ this.status = "aucune station dans la zone"; this.chip(); return; }
    this.stations = feats;
    for (const f of feats){
      const p = f.properties || {};
      const nameKey = Object.keys(p).find(k=>/nom|descri|station/i.test(k) && typeof p[k]==="string" && p[k].length>3);
      const name = p.NOM_STATION || p.NOM_STA || p.DES_STA || (nameKey?p[nameKey]:null) || "Station";
      const rowsHtml = Object.entries(p)
        .filter(([k,v])=>v!=null && v!=="" && !/geom|coord|^lat|^lon|objectid/i.test(k))
        .slice(0,14)
        .map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join("");
      const el = document.createElement("div"); el.className = "wq-marker";
      const popup = new maplibregl.Popup({offset:12, maxWidth:"340px"})
        .setHTML(`<div class="wq-popup"><b>💧 ${name}</b><br>
          <span style="color:var(--muted);font-size:.7rem">Réseau-Rivières (MELCCFP) — dernières valeurs publiées</span>
          <table>${rowsHtml}</table></div>`);
      this.markers.push(new maplibregl.Marker({element:el})
        .setLngLat(f.geometry.coordinates.slice(0,2)).setPopup(popup).addTo(window._map));
    }
    this.status = "ok"; this.chip();
  }
};
App.register(WaterQuality);
