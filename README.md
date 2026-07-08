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
| `js/config.js` | **Configuration** : stations, couches WMS, satellites, intervalles — seul fichier à modifier pour ajouter des données |
| `js/app.js` | Logique applicative (modules : niveaux, vent, carte, passages satellites, export) |

## Sources de données (toutes publiques, CORS ouverts)

- Niveaux d'eau : [IWLS/SINECO (MPO)](https://api-iwls.dfo-mpo.gc.ca) et [MSC GeoMet (ECCC)](https://api.weather.gc.ca) — temps réel + archives HYDAT
- Vent : SWOB temps réel (ECCC), archives climatiques horaires (ECCC), repli [Open-Meteo](https://open-meteo.com)
- Passages satellites : [Earth Search STAC](https://earth-search.aws.element84.com/v1) (Sentinel-2, Landsat) ; Planet/SuperDoves via clé API (bouton « Connecter Planet », clé stockée en localStorage seulement)
- Couches carte : WMS GeoMet (radar, température), tuiles © OpenStreetMap

## Extension

Ajoutez un module en enregistrant un objet dans `js/app.js` :

```js
App.register({
  async init(){ /* une fois au chargement */ },
  async refresh(){ /* à chaque actualisation */ }
});
```

Ajoutez une station, une couche WMS ou une constellation en modifiant simplement `js/config.js`.

## Avertissement

Données fournies à titre indicatif seulement. Les stations IWLS sont exprimées par rapport au zéro des cartes ; Lanoraie (ECCC) est en niveau géodésique (second axe du graphique).
