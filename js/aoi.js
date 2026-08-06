/* ============================================================
   MODULE : ZONE D'INTÉRÊT (AOI) — polygone de recherche satellite
   ------------------------------------------------------------
   • Dessin d'un polygone à la souris sur la carte (clic = sommet,
     double-clic ou « Terminer » = fermeture), mémorisé dans le navigateur.
   • Le polygone sert de géométrie de recherche STAC (`intersects`) et
     de GeometryFilter Planet : le serveur ne renvoie plus que les scènes
     qui touchent réellement la zone.
   • Aoi.overlap(geom) mesure le pourcentage de la zone couvert par une
     scène, ce qui permet d'écarter les scènes à faible recouvrement
     (celles qui n'attrapent la zone que par un coin).

   La mesure se fait par échantillonnage de points : aucune dépendance
   géométrique externe, et les polygones concaves / à trous sont gérés.
   ============================================================ */

/* ---------- géométrie élémentaire ---------- */
function pointInRing(pt, ring){
  let inside = false;
  for (let i=0, j=ring.length-1; i<ring.length; j=i++){
    const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    if (((yi>pt[1]) !== (yj>pt[1])) && (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi)) inside = !inside;
  }
  return inside;
}
function pointInPolygon(pt, rings){
  if (!rings?.length || !pointInRing(pt, rings[0])) return false;
  for (let i=1; i<rings.length; i++) if (pointInRing(pt, rings[i])) return false; // trous
  return true;
}
function pointInGeometry(pt, g){
  if (!g) return false;
  if (g.type === "Polygon")      return pointInPolygon(pt, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some(p=>pointInPolygon(pt, p));
  if (g.type === "GeometryCollection") return (g.geometries||[]).some(x=>pointInGeometry(pt, x));
  return false;
}
function bboxOfGeometry(g){
  let w=Infinity, s=Infinity, e=-Infinity, n=-Infinity;
  const walk = c => {
    if (typeof c[0] === "number"){ w=Math.min(w,c[0]); e=Math.max(e,c[0]); s=Math.min(s,c[1]); n=Math.max(n,c[1]); }
    else c.forEach(walk);
  };
  walk(g.coordinates);
  return [w,s,e,n];
}
const bboxToPolygon = ([w,s,e,n]) => ({ type:"Polygon", coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]] });

const Aoi = {
  KEY: "lspAoi.v1",
  polygon: null,        // GeoJSON Polygon personnalisé (null => emprise du lac)
  drawing: false,
  draft: [],
  _samples: null,
  onChange: null,

  init(){
    this.polygon = Store.get(this.KEY, null);
    this.buildTools();
    whenMap().then(m=>{ this.attach(m); this.draw(); });
  },

  /* Géométrie active : polygone personnalisé, sinon l'emprise du lac */
  geometry(){ return this.polygon || bboxToPolygon(CONFIG.lakeBbox); },
  isCustom(){ return !!this.polygon; },
  label(){ return this.polygon ? `polygone personnalisé (${this.polygon.coordinates[0].length-1} sommets)` : "emprise du lac"; },

  /* ---------- mesure de recouvrement ---------- */
  samples(){
    if (this._samples) return this._samples;
    const g = this.geometry();
    const [w,s,e,n] = bboxOfGeometry(g);
    const target = CONFIG.scenes.aoiSamples || 3000;
    // grille régulière sur la bbox ; on ne garde que les points dans la zone
    const side = Math.max(20, Math.ceil(Math.sqrt(target * 1.6)));
    const pts = [];
    for (let i=0; i<side; i++){
      const y = s + (n-s)*(i+0.5)/side;
      for (let j=0; j<side; j++){
        const x = w + (e-w)*(j+0.5)/side;
        if (pointInGeometry([x,y], g)) pts.push([x,y]);
      }
    }
    this._samples = pts.length ? pts : [[(w+e)/2,(s+n)/2]];
    return this._samples;
  },

  /* % de la zone d'intérêt couvert par la géométrie d'une scène */
  overlap(geom){
    if (!geom) return null;
    const pts = this.samples();
    let hit = 0;
    for (const p of pts) if (pointInGeometry(p, geom)) hit++;
    return 100 * hit / pts.length;
  },

  /* ---------- interface ---------- */
  buildTools(){
    const host = document.getElementById("aoi-tools");
    if (!host) return;
    host.innerHTML = `
      <span class="aoi-label">Zone de recherche satellite :</span>
      <span class="aoi-state" id="aoi-state"></span>
      <button class="btn sm" id="aoi-draw">✏ Dessiner</button>
      <button class="btn sm" id="aoi-finish" style="display:none">✓ Terminer</button>
      <button class="btn sm" id="aoi-cancel" style="display:none">✕ Annuler</button>
      <button class="btn sm" id="aoi-clear">↺ Emprise du lac</button>`;
    document.getElementById("aoi-draw").onclick   = ()=>this.startDraw();
    document.getElementById("aoi-finish").onclick = ()=>this.finishDraw();
    document.getElementById("aoi-cancel").onclick = ()=>this.cancelDraw();
    document.getElementById("aoi-clear").onclick  = ()=>this.clear();
    this.syncTools();
  },
  syncTools(){
    const st = document.getElementById("aoi-state");
    if (st) st.textContent = this.drawing
      ? `${this.draft.length} sommet${this.draft.length>1?"s":""} — cliquez pour ajouter, double-clic pour fermer`
      : this.label();
    const show = (id, v)=>{ const el=document.getElementById(id); if(el) el.style.display = v?"":"none"; };
    show("aoi-draw", !this.drawing);
    show("aoi-finish", this.drawing);
    show("aoi-cancel", this.drawing);
    show("aoi-clear", !this.drawing);
  },

  /* ---------- dessin ---------- */
  attach(map){
    const empty = { type:"FeatureCollection", features:[] };
    map.addSource("aoi", { type:"geojson", data:empty });
    map.addSource("aoi-draft", { type:"geojson", data:empty });
    map.addLayer({ id:"aoi-fill", type:"fill", source:"aoi",
      paint:{ "fill-color":"#3fb6ff", "fill-opacity":0.08 } });
    map.addLayer({ id:"aoi-line", type:"line", source:"aoi",
      paint:{ "line-color":"#3fb6ff", "line-width":2, "line-dasharray":[3,2] } });
    map.addLayer({ id:"aoi-draft-line", type:"line", source:"aoi-draft",
      paint:{ "line-color":"#ffb454", "line-width":2 } });
    map.addLayer({ id:"aoi-draft-pt", type:"circle", source:"aoi-draft",
      filter:["==","$type","Point"],
      paint:{ "circle-radius":4, "circle-color":"#ffb454", "circle-stroke-color":"#0d1420", "circle-stroke-width":1.5 } });

    this._onClick = e=>{
      if (!this.drawing) return;
      this.draft.push([e.lngLat.lng, e.lngLat.lat]);
      this.drawDraft(); this.syncTools();
    };
    this._onDbl = e=>{ if (this.drawing){ e.preventDefault?.(); this.finishDraw(); } };
    this._onKey = e=>{ if (e.key === "Escape" && this.drawing) this.cancelDraw();
                       if (e.key === "Enter"  && this.drawing) this.finishDraw(); };
    map.on("click", this._onClick);
    map.on("dblclick", this._onDbl);
    document.addEventListener("keydown", this._onKey);
  },

  startDraw(){
    this.drawing = true; this.draft = [];
    const m = window._map;
    if (m){ m.doubleClickZoom.disable(); m.getCanvas().style.cursor = "crosshair"; }
    this.drawDraft(); this.syncTools();
  },
  cancelDraw(){
    this.drawing = false; this.draft = [];
    const m = window._map;
    if (m){ m.doubleClickZoom.enable(); m.getCanvas().style.cursor = ""; }
    this.drawDraft(); this.syncTools();
  },
  finishDraw(){
    if (this.draft.length < 3){ this.cancelDraw(); return; }
    const ring = this.draft.slice();
    ring.push(ring[0]);
    this.polygon = { type:"Polygon", coordinates:[ring] };
    Store.set(this.KEY, this.polygon);
    this.cancelDraw();
    this.invalidate();
  },
  clear(){
    this.polygon = null;
    Store.set(this.KEY, null);
    this.invalidate();
  },
  invalidate(){
    this._samples = null;
    this.draw(); this.syncTools();
    this.onChange?.();
  },

  drawDraft(){
    const m = window._map, src = m?.getSource("aoi-draft");
    if (!src) return;
    const feats = this.draft.map(c=>({ type:"Feature", geometry:{ type:"Point", coordinates:c }, properties:{} }));
    if (this.draft.length > 1)
      feats.push({ type:"Feature", geometry:{ type:"LineString", coordinates:this.draft }, properties:{} });
    src.setData({ type:"FeatureCollection", features:feats });
  },
  draw(){
    const m = window._map, src = m?.getSource("aoi");
    if (!src) return;
    src.setData({ type:"FeatureCollection",
      features:[{ type:"Feature", geometry:this.geometry(), properties:{} }] });
  },

  /* Emprise d'une scène affichée sur la carte (aperçu) */
  showFootprint(geom){
    whenMap().then(m=>{
      if (!m.getSource("scene-fp")){
        m.addSource("scene-fp", { type:"geojson", data:{ type:"FeatureCollection", features:[] } });
        m.addLayer({ id:"scene-fp-fill", type:"fill", source:"scene-fp",
          paint:{ "fill-color":"#c792ea", "fill-opacity":0.12 } });
        m.addLayer({ id:"scene-fp-line", type:"line", source:"scene-fp",
          paint:{ "line-color":"#c792ea", "line-width":1.5 } });
      }
      m.getSource("scene-fp").setData(geom
        ? { type:"FeatureCollection", features:[{ type:"Feature", geometry:geom, properties:{} }] }
        : { type:"FeatureCollection", features:[] });
      if (geom){
        const [w,s,e,n] = bboxOfGeometry(geom);
        m.fitBounds([[w,s],[e,n]], { padding:40, duration:600, maxZoom:12 });
      }
    });
  }
};
App.register(Aoi);
