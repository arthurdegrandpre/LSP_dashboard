/* ============================================================
   CONFIGURATION — stations, couches, satellites.
   C'est le seul fichier à modifier pour ajouter des données.
   ============================================================ */
const CONFIG = {
  refreshMinutes: 10,
  historyYears: 3,           // nombre d'années précédentes superposées
  histMaxDays: 92,           // au-delà, les superpositions d'années sont désactivées (volume)
  maxCustomDays: 366,        // limite d'une période personnalisée (1 an)
  map: { center: [-72.83, 46.19], zoom: 9.2 },
  lakeBbox: [-73.0, 46.05, -72.65, 46.32],

  // Stations de niveau d'eau.
  // "iwls": SINECO/MPO (1 min, zéro des cartes) · "geomet": ECCC (5 min, géodésique)
  // axis:"y2" => second axe (échelles différentes)
  waterStations: [
    { key:"sorel",    name:"Sorel",                          type:"iwls",   id:"5cebf1e03d0f4a073c4bbe32", lat:46.0472, lon:-73.1157, color:"#3fb6ff", datum:"Zéro des cartes", axis:"y"  },
    { key:"lsp",      name:"Lac Saint-Pierre (Louiseville)", type:"iwls",   id:"5cebf1e03d0f4a073c4bbe49", lat:46.1948, lon:-72.8955, color:"#37d3a2", datum:"Zéro des cartes", axis:"y"  },
    { key:"lanoraie", name:"Lanoraie",                       type:"geomet", id:"02OB011",                  lat:45.9594, lon:-73.2146, color:"#ffb454", datum:"Niveau géodésique", axis:"y2" },
    { key:"tr",       name:"Trois-Rivières",                 type:"iwls",   id:"5cebf1df3d0f4a073c4bbbac", lat:46.3405, lon:-72.5392, color:"#c792ea", datum:"Zéro des cartes", axis:"y"  }
  ],

  // Stations météo — observations SWOB (temps réel) par code ICAO, repli Open-Meteo
  windStations: [
    { icao:"CWBS", name:"Varennes / Sorel",   lat:46.05,  lon:-73.13 },
    { icao:"CWNQ", name:"Nicolet",            lat:46.22,  lon:-72.62 },
    { icao:"CWTY", name:"Trois-Rivières AUT", lat:46.35,  lon:-72.52 },
    { icao:"CYRQ", name:"Trois-Rivières (aéroport)", lat:46.3516, lon:-72.6805 }
  ],

  // Archives climatiques horaires ECCC (vent à une date donnée)
  climateStations: [
    { id:"7018561", name:"Trois-Rivières A" }
    // Ajoutez d'autres CLIMATE_IDENTIFIER ici (voir collections/climate-stations)
  ],

  // Couches WMS GeoMet (STYLES obligatoire en WMS 1.3.0)
  overlays: [
    { key:"radar", name:"Radar précipitations", visible:false, opacity:0.7,
      tiles:"https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&LAYERS=RADAR_1KM_RRAI&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE" },
    { key:"temp", name:"Température de l'air (HRDPS)", visible:false, opacity:0.45,
      tiles:"https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&LAYERS=HRDPS.CONTINENTAL_TT&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE" }
  ],

  // Constellations suivies (STAC Earth Search). Planet/SuperDoves exige une clé API :
  // utilisez le bouton « Connecter Planet » sous le bandeau des passages.
  satellites: [
    { key:"s2", name:"Sentinel-2", color:"#37d3a2", stac:"sentinel-2-l2a", lane:12,
      external: d=>`https://browser.dataspace.copernicus.eu/?zoom=11&lat=46.19&lng=-72.85&themeId=DEFAULT-THEME&visualizationUrl=&datasetId=S2_L2A_CDAS&fromTime=${d}T00:00:00.000Z&toTime=${d}T23:59:59.999Z` },
    { key:"landsat", name:"Landsat 8/9", color:"#ffb454", stac:"landsat-c2-l2", lane:24,
      external: d=>`https://earthexplorer.usgs.gov/` },
    { key:"planet", name:"SuperDoves (Planet)", color:"#c792ea", lane:36, requiresKey:true,
      external: d=>`https://www.planet.com/explorer/#/mode/compare` }
  ],
  get planetApiKey(){ return localStorage.getItem("planetApiKey") || ""; }, // via bouton « Connecter Planet »

  stacApi: "https://earth-search.aws.element84.com/v1/search",

  // Qualité de l'eau — Réseau-Rivières (MELCCFP) via l'API CKAN de Données Québec.
  // Le module découvre automatiquement les ressources « datastore » du jeu de données
  // et affiche les stations situées dans waterQuality.bbox. Si l'API n'est pas
  // joignable (CORS/réseau), la couche est simplement marquée indisponible.
  waterQuality: {
    ckanBase: "https://www.donneesquebec.ca/recherche/api/3/action",
    datasetId: "suivi-physicochimique-des-rivieres-et-du-fleuve",
    bbox: [-73.3, 45.9, -72.4, 46.45],   // zone élargie autour du lac
    maxStations: 40
  }
};
