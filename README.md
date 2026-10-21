# Estran

**PWA d'aide à l'interprétation de structures géologiques visibles sur l'estran.**

## Fonctionnalités

1. **Définition de la zone d'étude**
   - Fonds de carte : IGN Plan V2, IGN BD Ortho, OpenStreetMap (Leaflet + WMTS Géoplatforme)
   - Sélection polygonale (Leaflet.draw)
   - Contrainte de longueur maximale ≈ 1 km

2. **Affichage restreint à la zone**
   - BD Ortho + ombrage MNT LiDAR HD (plugin [leaflet-relief](https://github.com/glandais/leaflet-relief) + tuiles IGN bil32)
   - Curseurs : opacité, contraste, luminosité, azimut du soleil, exagération verticale
   - Zooms min/max réglables 13–19

3. **Interprétation géologique**
   - Couches vectorielles indépendantes (nom libre : silex, faille…)
   - Dessin manuel polylignes / polygones (couleur & épaisseur réglables)

4. **Export**
   - Zone restreinte uniquement
   - GeoJSON (vecteurs + zone)
   - PNG (capture navigateur recommandée – CORS IGN)
   - GeoPackage : exporter en GeoJSON puis convertir (QGIS / ogr2ogr)

## Déploiement GitHub Pages

1. Créer un dépôt `estran` (ou autre nom)
2. Pousser le contenu de ce dossier à la racine (ou dans `/docs`)
3. Settings → Pages → Source : branch `main` / root (ou `/docs`)
4. L’URL sera `https://<user>.github.io/estran/`

Le service worker (`sw.js`) utilise un nom de cache versionné (`estran-v1.0.0-…`).  
Pour forcer le rafraîchissement après une mise à jour : incrémenter `CACHE_VERSION` dans `sw.js`.

## Développement local

```bash
# Serveur statique simple (évite les problèmes de SW / CORS relatifs)
npx serve .
# ou
python -m http.server 8080
```

Ouvrir `http://localhost:8080`.

## Limites connues

- Les tuiles LiDAR HD IGN sont un WMS on-demand (pas une pyramide CDN) → latence possible.
- Export MBTiles raster + vecteur n’est pas réaliste purement client-side ; préférer GeoJSON + QGIS.
- Contraste / luminosité appliqués via CSS `filter` sur le conteneur de la couche relief.
- Fonctionne principalement en France métropolitaine (couverture LiDAR HD).

## Stack

- Leaflet 1.9 + Leaflet.draw
- leaflet-relief (hillshade IGN LiDAR HD)
- Turf.js (calculs géométriques)
- PWA (manifest + service worker cache-busting)

Licence : usage libre. Données © IGN – Licence Ouverte.
