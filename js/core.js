/* ============================================================
   NOYAU — registre de modules, utilitaires réseau, préférences,
   et registre des séries temporelles (panneau latéral).

   Un module s'enregistre ainsi :
     App.register({ async init(){}, async refresh(){} });
   ============================================================ */

/* Chart.js 4 n'enregistre pas les plugins automatiquement — indispensable pour zoom/pan */
if (window.Chart && window.ChartZoom) Chart.register(window.ChartZoom);

const App = {
  modules: [],
  register(m){ this.modules.push(m); return m; },
  async init(){
    const el = document.getElementById("cfg-interval");
    if (el) el.textContent = CONFIG.refreshMinutes;
    for (const m of this.modules){
      try { await m.init?.(); } catch(e){ console.error("init module", e); }
    }
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
const iso     = d => new Date(d).toISOString().slice(0,19)+"Z";
const dayStr  = d => new Date(d).toISOString().slice(0,10);
const clamp   = (v,a,b) => Math.min(b, Math.max(a, v));

const subsample = (pts, n=1200) => {
  const step = Math.max(1, Math.round(pts.length/n));
  return pts.filter((_,i)=>i%step===0);
};

/* Attente de la carte MapLibre — résolue seulement quand le style est chargé,
   sinon addSource/addLayer échouent. */
const whenMap = () => new Promise(r=>{
  const ready = ()=>{ const m = window._map; return m && (!m.isStyleLoaded || m.isStyleLoaded()) ? m : null; };
  const now = ready();
  if (now) return r(now);
  const t = setInterval(()=>{ const m = ready(); if (m){ clearInterval(t); r(m); } }, 120);
});

/* Préférences persistées dans le navigateur (aucune donnée envoyée) */
const Store = {
  get(k, dflt){ try{ const v = localStorage.getItem(k); return v==null ? dflt : JSON.parse(v); }catch(e){ return dflt; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};

/* ============================================================
   REGISTRE DES SÉRIES + PANNEAU LATÉRAL
   ------------------------------------------------------------
   Chaque courbe possible du graphique est « déclarée » ici à partir
   de la configuration, AVANT tout appel réseau. Le panneau affiche
   la liste complète (regroupée par station) et seules les séries
   cochées sont réellement téléchargées puis tracées.

     SeriesPanel.declare(id, {group, groupLabel, label, color, kind, def})
     SeriesPanel.on(id)  -> true si la série est activée
     SeriesPanel.onChange = fn   (appelée à chaque modification)
   ============================================================ */
const SeriesPanel = {
  KEY: "lspSeries.v1",
  KEY_COLLAPSE: "lspSeriesCollapsed.v1",
  state: {},                 // id -> bool (choix explicites de l'utilisateur)
  defaults: {},              // id -> bool
  meta: {},                  // id -> descripteur
  groups: {},                // groupKey -> {label, color, ids:[]}
  order: [],                 // ordre d'affichage des groupes
  collapsedGroups: {},
  filter: "",
  onChange: null,
  _built: false,

  init(){
    this.state = Store.get(this.KEY, {});
    this.collapsedGroups = Store.get(this.KEY_COLLAPSE, {});
    const search = document.getElementById("sp-search");
    if (search){
      search.oninput = ()=>{ this.filter = search.value.trim().toLowerCase(); this.render(); };
    }
    const tog = document.getElementById("sp-collapse");
    if (tog){
      const panel = document.getElementById("series-panel");
      const apply = ()=>{
        const c = Store.get("lspPanelCollapsed", false);
        panel.classList.toggle("collapsed", !!c);
        tog.textContent = c ? "‹" : "›";
        tog.title = c ? "Afficher le panneau des séries" : "Réduire le panneau des séries";
      };
      tog.onclick = ()=>{ Store.set("lspPanelCollapsed", !Store.get("lspPanelCollapsed", false)); apply(); };
      apply();
    }
  },

  /* Vider le catalogue avant de le redéclarer (à chaque changement de période) */
  reset(){ this.meta = {}; this.groups = {}; this.order = []; },

  declare(id, d){
    this.meta[id] = Object.assign({ kind:"level", def:true }, d, { id });
    this.defaults[id] = this.meta[id].def;
    const g = d.group;
    if (!this.groups[g]){
      this.groups[g] = { key:g, label:d.groupLabel || g, color:d.groupColor || d.color, ids:[] };
      this.order.push(g);
    }
    this.groups[g].ids.push(id);
    return id;
  },

  on(id){
    if (this.meta[id]?.disabled) return false;
    const v = this.state[id];
    return v == null ? (this.defaults[id] !== false) : !!v;
  },
  /* état brut, en ignorant la désactivation temporaire (période trop longue) */
  checked(id){ const v = this.state[id]; return v == null ? (this.defaults[id] !== false) : !!v; },

  set(id, v, silent){
    this.state[id] = !!v;
    Store.set(this.KEY, this.state);
    if (!silent) this.changed();
  },
  setMany(ids, v){
    ids.forEach(id=>{ this.state[id] = !!v; });
    Store.set(this.KEY, this.state);
    this.changed();
  },
  changed(){ this.render(); this.onChange?.(); },

  activeIds(){ return Object.keys(this.meta).filter(id=>this.on(id)); },

  /* ---------- rendu ---------- */
  render(){
    const host = document.getElementById("sp-groups");
    if (!host) return;
    host.innerHTML = "";

    const f = this.filter;
    let shown = 0, active = 0;

    for (const gk of this.order){
      const g = this.groups[gk];
      const ids = g.ids.filter(id=>{
        if (!f) return true;
        const m = this.meta[id];
        return (m.label + " " + g.label).toLowerCase().includes(f);
      });
      active += g.ids.filter(id=>this.on(id)).length;
      if (!ids.length) continue;
      shown += ids.length;

      const box = document.createElement("div");
      box.className = "sp-group";
      const allOn = ids.every(id=>this.checked(id));
      const someOn = ids.some(id=>this.checked(id));
      const isCollapsed = !!this.collapsedGroups[gk] && !f;

      const head = document.createElement("div");
      head.className = "sp-ghead";
      head.innerHTML = `
        <input type="checkbox" ${allOn?"checked":""}>
        <span class="sp-dot" style="background:${g.color||"#5a6a84"}"></span>
        <span class="sp-gname">${g.label}</span>
        <span class="sp-gcount">${ids.filter(id=>this.checked(id)).length}/${ids.length}</span>
        <button class="sp-caret" title="Replier / déplier">${isCollapsed?"▸":"▾"}</button>`;
      const cb = head.querySelector("input");
      cb.indeterminate = someOn && !allOn;
      cb.onchange = ()=>this.setMany(ids, cb.checked);
      head.querySelector(".sp-caret").onclick = ()=>{
        this.collapsedGroups[gk] = !this.collapsedGroups[gk];
        Store.set(this.KEY_COLLAPSE, this.collapsedGroups);
        this.render();
      };
      head.querySelector(".sp-gname").onclick = ()=>{
        this.collapsedGroups[gk] = !this.collapsedGroups[gk];
        Store.set(this.KEY_COLLAPSE, this.collapsedGroups);
        this.render();
      };
      box.appendChild(head);

      if (!isCollapsed){
        const list = document.createElement("div");
        list.className = "sp-items";
        for (const id of ids){
          const m = this.meta[id];
          const row = document.createElement("label");
          row.className = "sp-item" + (m.disabled ? " disabled" : "");
          row.title = m.disabled ? (m.disabledReason || "Indisponible pour cette période") : m.label;
          row.innerHTML = `
            <input type="checkbox" ${this.checked(id)?"checked":""} ${m.disabled?"disabled":""}>
            <span class="sp-line" style="${this.lineStyle(m)}"></span>
            <span class="sp-label">${m.label}</span>`;
          row.querySelector("input").onchange = e=>this.set(id, e.target.checked);
          list.appendChild(row);
        }
        box.appendChild(list);
      }
      host.appendChild(box);
    }

    if (!shown){
      host.innerHTML = `<div class="sp-empty">Aucune série ne correspond à « ${this.filter} ».</div>`;
    }
    const cnt = document.getElementById("sp-count");
    if (cnt) cnt.textContent = `${active}/${Object.keys(this.meta).length}`;
    this.renderQuick();
  },

  lineStyle(m){
    const c = m.color || "#5a6a84";
    if (m.dash === "dash") return `background:repeating-linear-gradient(90deg,${c} 0 6px,transparent 6px 10px)`;
    if (m.dash === "dot")  return `background:repeating-linear-gradient(90deg,${c} 0 2px,transparent 2px 5px)`;
    return `background:${c}`;
  },

  /* boutons de sélection rapide par type de série */
  renderQuick(){
    const host = document.getElementById("sp-quick");
    if (!host) return;
    const kinds = [
      { kind:"level", label:"Niveaux" },
      { kind:"mean",  label:"Moyennes" },
      { kind:"hist",  label:"Années préc." },
      { kind:"wind",  label:"Vent" },
      { kind:"gust",  label:"Rafales" },
      { kind:"windhist", label:"Vent — années préc." }
    ];
    host.innerHTML = "";
    const mk = (label, cls, fn, title)=>{
      const b = document.createElement("button");
      b.className = "sp-chip " + (cls||"");
      b.textContent = label;
      if (title) b.title = title;
      b.onclick = fn;
      host.appendChild(b);
      return b;
    };
    mk("Tout", "", ()=>this.setMany(Object.keys(this.meta), true), "Afficher toutes les séries");
    mk("Rien", "", ()=>this.setMany(Object.keys(this.meta), false), "Masquer toutes les séries");
    for (const k of kinds){
      const ids = Object.keys(this.meta).filter(id=>this.meta[id].kind===k.kind);
      if (!ids.length) continue;
      const allOn = ids.every(id=>this.checked(id));
      mk(`${allOn?"✓ ":""}${k.label}`, allOn?"on":"", ()=>this.setMany(ids, !allOn),
        `${allOn?"Masquer":"Afficher"} : ${k.label} (${ids.length} séries)`);
    }
  }
};
