/* ============================================================
   MODULE : PASSAGES SATELLITES (STAC Earth Search + Planet)
   ------------------------------------------------------------
   • Recherche limitée à la zone d'intérêt (module Aoi) : polygone
     envoyé au serveur (`intersects` en STAC, GeometryFilter chez Planet).
   • Deux filtres côté client, appliqués instantanément :
       – couverture nuageuse maximale ;
       – recouvrement minimal de la zone, calculé par échantillonnage
         de l'emprise de chaque scène. C'est ce filtre qui écarte les
         scènes qui ne mordent la zone que par un coin — cas très
         fréquent avec les tuiles Planet/SuperDoves.
   ============================================================ */
const Overpass = {
  KEY: "lspSceneFilters.v1",
  items: [], planetError: null, loading: false,
  filters: null,

  init(){
    this.filters = Object.assign({
      maxCloud: CONFIG.scenes.maxCloud,
      minOverlap: CONFIG.scenes.minOverlap,
      unknownCloud: CONFIG.scenes.unknownCloud
    }, Store.get(this.KEY, {}));
    this.buildFilterUI();
    // redessiner la recherche quand la zone d'intérêt change
    Aoi.onChange = ()=>this.refresh();
  },

  /* ---------- filtres ---------- */
  saveFilters(){ Store.set(this.KEY, this.filters); },
  buildFilterUI(){
    const host = document.getElementById("sat-filters");
    if (!host) return;
    host.innerHTML = `
      <div class="sf-row">
        <label class="sf-ctl">Nuages ≤
          <input type="range" id="sf-cloud" min="0" max="100" step="5" value="${this.filters.maxCloud}">
          <b id="sf-cloud-v">${this.filters.maxCloud} %</b>
        </label>
        <label class="sf-chk"><input type="checkbox" id="sf-unknown" ${this.filters.unknownCloud?"checked":""}> garder les scènes sans info nuages</label>
        <label class="sf-ctl">Recouvrement de la zone ≥
          <input type="range" id="sf-ovl" min="0" max="100" step="5" value="${this.filters.minOverlap}">
          <b id="sf-ovl-v">${this.filters.minOverlap} %</b>
        </label>
        <span class="sf-count" id="sf-count"></span>
      </div>`;
    const cloud = host.querySelector("#sf-cloud"), ovl = host.querySelector("#sf-ovl");
    const upd = ()=>{
      this.filters.maxCloud = +cloud.value;
      this.filters.minOverlap = +ovl.value;
      this.filters.unknownCloud = host.querySelector("#sf-unknown").checked;
      host.querySelector("#sf-cloud-v").textContent = this.filters.maxCloud + " %";
      host.querySelector("#sf-ovl-v").textContent = this.filters.minOverlap + " %";
      this.saveFilters();
      this.renderLegend();
      this.reposition(Levels.from, Levels.to);
    };
    cloud.oninput = upd; ovl.oninput = upd;
    host.querySelector("#sf-unknown").onchange = upd;
  },

  /* Scènes retenues par les filtres courants */
  visible(){
    const f = this.filters;
    return this.items.filter(it=>{
      if (it.cloud == null){ if (!f.unknownCloud) return false; }
      else if (it.cloud > f.maxCloud) return false;
      if (f.minOverlap > 0 && (it.overlap == null || it.overlap < f.minOverlap)) return false;
      return true;
    });
  },

  /* ---------- chargement ---------- */
  async refresh(){
    // une modification de zone pendant un chargement ne doit pas être perdue :
    // on note la demande et on relance une fois le chargement courant terminé
    if (this.loading){ this._pending = true; return; }
    this.loading = true;
    this.items = [];
    this.planetError = null;
    const dt = `${iso(Levels.from)}/${iso(Levels.to)}`;
    const geom = Aoi.geometry();
    try {
      await Promise.allSettled(CONFIG.satellites.filter(s=>s.stac).map(async sat=>{
        const feats = await this.stacSearch(sat, dt, geom);
        for (const f of feats){
          this.items.push({ sat, id:f.id, time:new Date(f.properties.datetime).getTime(),
            cloud: f.properties["eo:cloud_cover"] ?? null,
            geom: f.geometry || null,
            overlap: Aoi.overlap(f.geometry),
            thumb: f.assets?.thumbnail?.href || f.assets?.rendered_preview?.href || null,
            selfUrl: f.links?.find(l=>l.rel==="self")?.href });
        }
      }));
      if (CONFIG.planetApiKey) await this.fetchPlanet(dt, geom).catch(e=>{ this.planetError = e.message; });
      this.items.sort((a,b)=>a.time-b.time);
    } finally {
      this.loading = false;
    }
    this.renderLegend();
    this.reposition(Levels.from, Levels.to);
    if (this._pending){ this._pending = false; return this.refresh(); }
  },

  /* STAC : POST avec `intersects` (polygone) ; repli GET avec bbox */
  async stacSearch(sat, dt, geom){
    const body = { collections:[sat.stac], intersects:geom, datetime:dt, limit:100 };
    const out = [];
    try {
      let next = { href: CONFIG.stacApi, method:"POST", body };
      for (let page=0; page<3 && next; page++){
        const r = next.method === "GET"
          ? await fetch(next.href)
          : await fetch(next.href, { method:"POST", headers:{"Content-Type":"application/json"},
              body: JSON.stringify(next.body) });
        if (!r.ok) throw new Error("HTTP "+r.status);
        const d = await r.json();
        out.push(...(d.features||[]));
        const link = (d.links||[]).find(l=>l.rel==="next");
        next = link ? { href:link.href, method:link.method||"GET",
          body: link.body ? (link.merge ? Object.assign({}, body, link.body) : link.body) : body } : null;
        if (!d.features?.length) break;
      }
      return out;
    } catch(e){
      // repli : ancienne recherche par emprise rectangulaire
      const d = await fetchJSON(`${CONFIG.stacApi}?collections=${sat.stac}&bbox=${CONFIG.lakeBbox.join(",")}&datetime=${dt}&limit=100`);
      return d.features||[];
    }
  },

  /* Planet Data API — quick-search des PSScene (SuperDoves), polygone AOI */
  async fetchPlanet(dt, geom){
    const sat = CONFIG.satellites.find(s=>s.key==="planet");
    const [t0,t1] = dt.split("/");
    const key = CONFIG.planetApiKey;
    const auth = { "Content-Type":"application/json", "Authorization":"api-key "+key };
    const searchGeom = geom.type === "Polygon" ? geom
      : { type:"Polygon", coordinates:[[
          [CONFIG.lakeBbox[0],CONFIG.lakeBbox[1]],[CONFIG.lakeBbox[2],CONFIG.lakeBbox[1]],
          [CONFIG.lakeBbox[2],CONFIG.lakeBbox[3]],[CONFIG.lakeBbox[0],CONFIG.lakeBbox[3]],
          [CONFIG.lakeBbox[0],CONFIG.lakeBbox[1]]]] };
    let r = await fetch("https://api.planet.com/data/v1/quick-search", {
      method:"POST", headers:auth,
      body: JSON.stringify({
        item_types:["PSScene"],
        filter:{ type:"AndFilter", config:[
          { type:"GeometryFilter", field_name:"geometry", config:searchGeom },
          { type:"DateRangeFilter", field_name:"acquired", config:{ gte:t0, lte:t1 } }
        ]}
      })
    });
    if (r.status===401 || r.status===403) throw new Error("clé refusée");
    if (!r.ok) throw new Error("HTTP "+r.status);
    let d = await r.json();
    for (let page=0; page<(CONFIG.scenes.planetPages||1); page++){
      for (const f of d.features||[]){
        this.items.push({ sat, id:f.id, time:new Date(f.properties.acquired).getTime(),
          cloud: f.properties.cloud_percent ?? (f.properties.cloud_cover!=null ? f.properties.cloud_cover*100 : null),
          geom: f.geometry || null,
          overlap: Aoi.overlap(f.geometry),
          thumb: f._links?.thumbnail ? f._links.thumbnail+"?api_key="+key : null,
          selfUrl: f._links?._self });
      }
      const nx = d._links?._next;
      if (!nx || !(d.features||[]).length) break;
      r = await fetch(nx, { headers:{ "Authorization":"api-key "+key } });
      if (!r.ok) break;
      d = await r.json();
    }
  },

  /* ---------- rendu ---------- */
  renderLegend(){
    const legend = document.getElementById("op-legend");
    const vis = this.visible();
    legend.innerHTML = "";
    CONFIG.satellites.filter(s=>!s.requiresKey).forEach(s=>{
      const n = vis.filter(i=>i.sat===s).length, tot = this.items.filter(i=>i.sat===s).length;
      const el = document.createElement("span");
      el.style.color = s.color;
      el.textContent = `${s.name} — ${n}${tot!==n?` / ${tot}`:""}`;
      legend.appendChild(el);
    });
    const planet = CONFIG.satellites.find(s=>s.requiresKey);
    const chip = document.createElement("span");
    chip.style.color = planet.color; chip.style.cursor = "pointer";
    if (CONFIG.planetApiKey){
      const n = vis.filter(i=>i.sat===planet).length, tot = this.items.filter(i=>i.sat===planet).length;
      chip.innerHTML = this.planetError
        ? `${planet.name} — erreur : ${this.planetError} (cliquer pour reconfigurer)`
        : `${planet.name} ✓ ${n}${tot!==n?` / ${tot}`:""} scènes — cliquer pour déconnecter`;
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

    const cnt = document.getElementById("sf-count");
    if (cnt){
      const hidden = this.items.length - vis.length;
      cnt.textContent = `${vis.length} scène${vis.length>1?"s":""} retenue${vis.length>1?"s":""}` +
        (hidden>0 ? ` · ${hidden} écartée${hidden>1?"s":""} par les filtres` : "") +
        ` · zone : ${Aoi.label()}`;
    }
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
        const probe = [];
        const keep = this.items; this.items = probe;
        await this.fetchPlanet(`${iso(Date.now()-7*864e5)}/${iso(Date.now())}`, Aoi.geometry());
        this.items = keep;
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
    if (!strip) return;
    strip.querySelectorAll(".op-dot,.lane-label").forEach(e=>e.remove());
    CONFIG.satellites.forEach(s=>{
      const lbl = document.createElement("span");
      lbl.className="lane-label"; lbl.style.top=(s.lane-6)+"px"; lbl.textContent=s.name;
      strip.appendChild(lbl);
    });
    for (const it of this.visible()){
      if (it.time < minX || it.time > maxX) continue;
      const dot = document.createElement("div");
      dot.className="op-dot";
      dot.style.left = (100*(it.time-minX)/(maxX-minX))+"%";
      dot.style.top = it.sat.lane+"px";
      dot.style.background = it.sat.color;
      // opacité proportionnelle au recouvrement : les scènes marginales s'effacent
      if (it.overlap != null) dot.style.opacity = (0.35 + 0.65*clamp(it.overlap/100,0,1)).toFixed(2);
      dot.title = `${it.sat.name} · ${new Date(it.time).toLocaleString("fr-CA")}` +
        (it.cloud!=null?` · nuages ${Math.round(it.cloud)} %`:" · nuages ?") +
        (it.overlap!=null?` · zone couverte ${Math.round(it.overlap)} %`:"");
      dot.onclick = ()=>this.preview(it);
      strip.appendChild(dot);
    }
  },

  preview(it){
    const d = dayStr(it.time);
    const ovl = it.overlap==null ? "—" : `${Math.round(it.overlap)} %`;
    document.getElementById("modal-content").innerHTML = `
      <h3 style="margin-bottom:4px">${it.sat.name}</h3>
      <div class="sub" style="margin-bottom:10px">${it.id}<br>
        ${new Date(it.time).toLocaleString("fr-CA")}</div>
      <div class="scene-stats">
        <div><span>Nuages</span><b>${it.cloud!=null?Math.round(it.cloud)+" %":"inconnu"}</b></div>
        <div><span>Zone couverte</span><b>${ovl}</b></div>
      </div>
      ${it.thumb?`<img src="${it.thumb}" alt="aperçu" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'sub',textContent:'Aperçu non disponible'}))">`:`<div class="sub">Aperçu non disponible</div>`}
      <div class="links">
        ${it.geom?`<a href="#" id="show-fp">Voir l'emprise sur la carte ↗</a>`:""}
        ${it.sat.external?`<a href="${it.sat.external(d)}" target="_blank">Visualiseur externe ↗</a>`:""}
        ${it.selfUrl?`<a href="${it.selfUrl}" target="_blank">Métadonnées ↗</a>`:""}
      </div>`;
    document.getElementById("modal").classList.add("open");
    const fp = document.getElementById("show-fp");
    if (fp) fp.onclick = e=>{
      e.preventDefault();
      Aoi.showFootprint(it.geom);
      document.getElementById("modal").classList.remove("open");
      document.getElementById("map-card").scrollIntoView({behavior:"smooth", block:"center"});
    };
  }
};
App.register(Overpass);
