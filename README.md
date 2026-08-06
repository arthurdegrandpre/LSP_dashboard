# Tableau de bord environnemental — Lac Saint-Pierre

Application web statique (aucun serveur requis) affichant en temps réel les conditions du lac Saint-Pierre (fleuve Saint-Laurent) : niveaux d'eau, vent, passages satellites et couches de données ouvertes.

## Publication sur GitHub Pages

1. Créez un dépôt GitHub et poussez le contenu de ce dossier à la racine :

   ```bash
   git init
   git add .
   git commit -m "Tableau de bord lac Saint-Pierre"
   git branch -M main
   git remote add origin https://github.com/<utilisateur>/<depot>.git
   git push -u origin main
   ```

2. Dans le dépôt : **Settings → Pages → Source : Deploy from a branch → main / (root) → Save**.
3. Le site sera servi à `https://<utilisateur>.github.io/<depot>/`.

Le fichier `.nojekyll` désactive le traitement Jekyll (inutile ici).

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page |
| `css/style.css` | Thème et mise en page |
| `js/config.js` | **Configuration** : stations, séries de vent, couches WMS, satellites, filtres — seul fichier à modifier pour ajouter des données |
| `js/core.js` | Registre de modules, utilitaires réseau, préférences, **registre des séries et panneau latéral** |
| `js/aoi.js` | Zone d'intérêt : dessin du polygone, mesure de recouvrement |
| `js/wind.js` | Sources de vent (séries horaires, temps réel) et widget météo |
| `js/satellites.js` | Passages satellites, filtres nuages et recouvrement |
| `js/layers.js` | Carte MapLibre, couches WMS, qualité de l'eau |
| `js/app.js` | Graphique des séries temporelles (niveaux + vent) et export |

Les fichiers sont chargés dans cet ordre par `index.html` ; tout est global, il n'y a ni build ni bundler.

## Sources de données (toutes publiques, CORS ouverts)

- Niveaux d'eau : [IWLS/SINECO (MPO)](https://api-iwls.dfo-mpo.gc.ca) et [MSC GeoMet (ECCC)](https://api.weather.gc.ca) — temps réel + archives HYDAT
- Vent : SWOB temps réel (ECCC), archives climatiques horaires (ECCC), [Open-Meteo](https://open-meteo.com) (réanalyse + prévision, tout point du lac, sans clé)
- Passages satellites : [Earth Search STAC](https://earth-search.aws.element84.com/v1) (Sentinel-2, Landsat) ; Planet/SuperDoves via clé API (bouton « Connecter Planet », clé stockée en localStorage seulement)
- Couches carte : WMS GeoMet (radar, température), tuiles © OpenStreetMap

## Séries temporelles

Le graphique superpose les **niveaux d'eau** (m) et les **vitesses de vent** (km/h, axe de droite dédié) : niveau courant, années précédentes, moyenne pluriannuelle, vitesse du vent, rafales et vent des années précédentes.

La sélection se fait dans le **panneau latéral**, conçu pour un grand nombre de séries :

- une entrée par courbe, **regroupée par station**, avec case maîtresse par groupe (sélection par station en un clic) ;
- boutons rapides par type — *Niveaux, Moyennes, Années préc., Vent, Rafales, Vent — années préc.* — plus *Tout* / *Rien* ;
- champ de filtre textuel, groupes repliables, panneau réductible ;
- la sélection est mémorisée dans le navigateur d'une visite à l'autre.

**Seules les séries cochées sont téléchargées.** Le catalogue est construit à partir de `config.js` avant tout appel réseau, et les résultats sont mis en cache par (série, période) : cocher puis décocher une courbe ne relance aucune requête. Les superpositions d'années sont automatiquement désactivées au-delà de `histMaxDays` jours.

Le survol du graphique affiche le vent, la direction et la température à la date pointée, à partir des séries déjà chargées.

## Recherche de scènes satellites

Sous la carte, **Zone de recherche satellite** définit la géométrie interrogée :

- *Dessiner* — clic pour poser chaque sommet, double-clic (ou *Terminer*, ou `Entrée`) pour fermer, `Échap` pour annuler. Le polygone est mémorisé dans le navigateur.
- *Emprise du lac* — revient au rectangle par défaut (`CONFIG.lakeBbox`).

Le polygone est envoyé au serveur : `intersects` pour la recherche STAC, `GeometryFilter` pour la recherche Planet. Deux curseurs affinent ensuite le résultat côté client, sans nouvelle requête :

- **Nuages ≤ n %** — avec option de conserver ou non les scènes sans information de couverture nuageuse ;
- **Recouvrement de la zone ≥ n %** — proportion de la zone d'intérêt réellement couverte par la scène. C'est le filtre qui écarte les scènes qui n'attrapent la zone que par un coin, cas très fréquent avec les tuiles Planet/SuperDoves.

Le recouvrement est mesuré par échantillonnage de points (`CONFIG.scenes.aoiSamples`), sans dépendance géométrique externe ; les polygones concaves et les trous sont gérés. L'opacité de chaque pastille du bandeau est proportionnelle au recouvrement, et l'aperçu d'une scène permet d'afficher son emprise sur la carte.

## Export

`Exporter CSV` / `JSON` reprennent la fenêtre temporelle affichée : niveaux d'eau (courants et années précédentes), séries de vent horaires (vitesse, direction, rafales, température), vent temps réel et scènes satellites **retenues par les filtres** (avec couverture nuageuse et recouvrement). L'export JSON joint la géométrie de la zone d'intérêt, les filtres appliqués et la liste des séries affichées.

## Extension

Ajoutez un module en enregistrant un objet dans un nouveau fichier `js/` (puis une balise `<script>` dans `index.html`) :

```js
App.register({
  async init(){ /* une fois au chargement */ },
  async refresh(){ /* à chaque actualisation */ }
});
```

Une station, une série de vent, une couche WMS ou une constellation s'ajoutent en modifiant uniquement `js/config.js`. Une nouvelle série de vent sans `climateId` est servie par Open-Meteo pour n'importe quelle coordonnée.

## Avertissement

Données fournies à titre indicatif seulement. Les stations IWLS sont exprimées par rapport au zéro des cartes ; Lanoraie (ECCC) est en niveau géodésique (second axe du graphique). Les séries de vent sans identifiant climatique proviennent d'un modèle (réanalyse Open-Meteo) et non d'une observation.
