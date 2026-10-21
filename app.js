/* Estran – application PWA d'interprétation géologique de l'estran */
(function () {
  'use strict';

  // ---------- Configuration IGN / OSM ----------
  const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    '&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

  const BASEMAPS = {
    plan: L.tileLayer(
      IGN_WMTS + '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&FORMAT=image/png',
      { attribution: '© IGN', maxZoom: 19, maxNativeZoom: 19 }
    ),
    ortho: L.tileLayer(
      IGN_WMTS + '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&FORMAT=image/jpeg',
      { attribution: '© IGN – BD Ortho', maxZoom: 19, maxNativeZoom: 19 }
    ),
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    })
  };

  // ---------- État global ----------
  const state = {
    mode: 'define',          // 'define' | 'restricted'
    zoneLayer: null,         // L.Polygon
    zoneGeoJSON: null,
    currentBasemap: 'ortho',
    reliefLayer: null,
    geologyLayers: {},       // name -> { group, color, weight, features }
    activeGeology: null,
    drawControl: null,
    drawnItems: new L.FeatureGroup()
  };

  // ---------- Carte ----------
  const map = L.map('map', {
    center: [48.85, 2.30],  // Île-de-France (couverture LiDAR HD confirmée)
    zoom: 12,
    minZoom: 8,
    maxZoom: 19,
    zoomControl: true
  });

  BASEMAPS.ortho.addTo(map);
  map.addLayer(state.drawnItems);

  // ---------- Contrôles UI ----------
  const $ = (id) => document.getElementById(id);

  // Basemap switcher
  $('basemap-select').addEventListener('change', (e) => {
    const key = e.target.value;
    if (state.mode === 'restricted') return; // en mode restreint on force ortho
    Object.values(BASEMAPS).forEach(l => map.removeLayer(l));
    BASEMAPS[key].addTo(map);
    state.currentBasemap = key;
  });

  // ---------- 1. Dessin de la zone (tracé manuel fiable) ----------
  let drawPts = [];           // L.LatLng[]
  let drawMarkers = [];       // L.CircleMarker[]
  let drawPolyline = null;    // L.Polyline guide
  let drawingZone = false;
  let drawingFeature = false;
  let featurePts = [];
  let featureMarkers = [];
  let featurePolyline = null;

  function clearDrawGuides() {
    drawMarkers.forEach(m => map.removeLayer(m));
    drawMarkers = [];
    if (drawPolyline) { map.removeLayer(drawPolyline); drawPolyline = null; }
    drawPts = [];
  }

  function clearFeatureGuides() {
    featureMarkers.forEach(m => map.removeLayer(m));
    featureMarkers = [];
    if (featurePolyline) { map.removeLayer(featurePolyline); featurePolyline = null; }
    featurePts = [];
  }

  function stopDrawing() {
    drawingZone = false;
    drawingFeature = false;
    map.doubleClickZoom.enable();
    map.getContainer().style.cursor = '';
    clearDrawGuides();
    clearFeatureGuides();
    const btnFin = $('btn-finish-draw');
    if (btnFin) btnFin.style.display = 'none';
  }

  function updateDrawGuide() {
    if (drawPolyline) map.removeLayer(drawPolyline);
    if (drawPts.length >= 2) {
      drawPolyline = L.polyline(drawPts, { color: '#e94560', weight: 2, dashArray: '6 4' }).addTo(map);
    }
  }

  function addDrawPoint(latlng) {
    drawPts.push(latlng);
    const m = L.circleMarker(latlng, {
      radius: 5, color: '#fff', weight: 2, fillColor: '#e94560', fillOpacity: 1
    }).addTo(map);
    drawMarkers.push(m);
    updateDrawGuide();
    $('zone-info').textContent =
      `${drawPts.length} point(s) — cliquez pour ajouter, puis « Terminer le tracé » (min. 3 points).`;
  }

  function finishZonePolygon() {
    if (drawPts.length < 3) {
      alert('Il faut au moins 3 points pour un polygone.');
      return;
    }
    const latlngs = drawPts.slice();
    // fermer le polygone
    const layer = L.polygon(latlngs, {
      color: '#e94560', weight: 2, fillOpacity: 0.15
    });
    const geo = layer.toGeoJSON();
    const length = estimateLength(geo);

    if (length > 1100) {
      alert(`Le secteur fait environ ${Math.round(length)} m de long. Maximum autorisé : 1 000 m.`);
      stopDrawing();
      $('zone-info').textContent = 'Aucun secteur défini';
      return;
    }

    if (state.zoneLayer) {
      state.drawnItems.removeLayer(state.zoneLayer);
      map.removeLayer(state.zoneLayer);
    }
    state.zoneLayer = layer;
    state.zoneGeoJSON = geo;
    state.drawnItems.addLayer(layer);

    stopDrawing();

    $('zone-info').textContent = `Secteur défini – longueur ≈ ${Math.round(length)} m`;
    $('zone-info').classList.add('active');
    $('btn-clear-zone').disabled = false;
    $('btn-draw-zone').disabled = true;

    enterRestrictedMode();
  }

  $('btn-draw-zone').addEventListener('click', () => {
    stopDrawing();
    drawingZone = true;
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = 'crosshair';
    $('zone-info').textContent = 'Cliquez sur la carte pour placer les sommets (min. 3), puis « Terminer le tracé ».';
    $('zone-info').classList.remove('active');
    const btnFin = $('btn-finish-draw');
    if (btnFin) btnFin.style.display = '';
  });

  $('btn-finish-draw') && $('btn-finish-draw').addEventListener('click', () => {
    if (drawingZone) finishZonePolygon();
    else if (drawingFeature) finishFeatureShape();
  });

  function estimateLength(geo) {
    const bbox = turf.bbox(geo);
    const [minX, minY, maxX, maxY] = bbox;
    const w = turf.distance([minX, minY], [maxX, minY], { units: 'meters' });
    const h = turf.distance([minX, minY], [minX, maxY], { units: 'meters' });
    return Math.max(w, h);
  }

  $('btn-clear-zone').addEventListener('click', () => {
    stopDrawing();
    if (state.zoneLayer) {
      state.drawnItems.removeLayer(state.zoneLayer);
      map.removeLayer(state.zoneLayer);
    }
    state.zoneLayer = null;
    state.zoneGeoJSON = null;
    leaveRestrictedMode();
    $('zone-info').textContent = 'Aucun secteur défini';
    $('zone-info').classList.remove('active');
    $('btn-clear-zone').disabled = true;
    $('btn-draw-zone').disabled = false;
  });

  // Clic carte : ajout de points en mode dessin
  map.on('click', (e) => {
    if (drawingZone) {
      addDrawPoint(e.latlng);
    } else if (drawingFeature) {
      addFeaturePoint(e.latlng);
    }
  });

  // ---------- 2. Mode restreint + Hillshade ----------
  function enterRestrictedMode() {
    state.mode = 'restricted';

    // Forcer BD Ortho
    Object.values(BASEMAPS).forEach(l => map.removeLayer(l));
    BASEMAPS.ortho.addTo(map);
    $('basemap-select').value = 'ortho';
    $('basemap-select').disabled = true;

    // Afficher les panneaux
    $('sec-relief').style.display = '';
    $('sec-geology').style.display = '';
    $('sec-export').style.display = '';

    // Bornes de la carte
    const bounds = L.geoJSON(state.zoneGeoJSON).getBounds().pad(0.05);
    map.setMaxBounds(bounds);
    map.fitBounds(bounds);
    map.setMinZoom(13);
    map.setMaxZoom(19);

    // Créer la couche relief LIDAR HD
    createReliefLayer();
    // Forcer le redraw après le fitBounds
    setTimeout(() => {
      map.invalidateSize();
      if (state.reliefLayer && state.reliefLayer.redraw) state.reliefLayer.redraw();
    }, 300);
  }

  function leaveRestrictedMode() {
    state.mode = 'define';
    if (state.reliefLayer) {
      map.removeLayer(state.reliefLayer);
      state.reliefLayer = null;
    }
    map.setMaxBounds(null);
    map.setMinZoom(8);
    map.setMaxZoom(19);
    $('basemap-select').disabled = false;
    $('sec-relief').style.display = 'none';
    $('sec-geology').style.display = 'none';
    $('sec-export').style.display = 'none';

    // Nettoyer couches géologiques
    Object.values(state.geologyLayers).forEach(l => map.removeLayer(l.group));
    state.geologyLayers = {};
    state.activeGeology = null;
    $('layers-list').innerHTML = '';
    $('btn-draw-feature').disabled = true;
  }

  // ---- Ombrage MNT LiDAR HD ----
  // WMTS SHADOW = ombrage précalculé IGN (fiable, rapide)
  // Mode interactif = calcul client via WMS bil32 (lent, rate-limité ~1 req/s)
  const IGN_SHADOW_URL =
    'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
    '&LAYER=IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW' +
    '&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM' +
    '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

  // Pane dédié au-dessus de l'ortho
  if (!map.getPane('reliefPane')) {
    map.createPane('reliefPane');
    map.getPane('reliefPane').style.zIndex = 450;
    map.getPane('reliefPane').style.pointerEvents = 'none';
  }

  function createReliefLayer() {
    if (state.reliefLayer) {
      map.removeLayer(state.reliefLayer);
      state.reliefLayer = null;
    }

    const opacity = +$('hs-opacity').value;
    const wantInteractive = $('relief-mode') && $('relief-mode').value === 'interactive';
    const hasPlugin =
      typeof L.gridLayer !== 'undefined' &&
      typeof L.gridLayer.relief === 'function' &&
      L.GridLayer.Relief &&
      L.GridLayer.Relief.elevationUrls;

    if (wantInteractive && hasPlugin) {
      try {
        state.reliefLayer = L.gridLayer.relief({
          mode: 'hillshade',
          elevationUrl: L.GridLayer.Relief.elevationUrls.ignLidarHdMnt,
          elevationTileDecoder: L.GridLayer.Relief.elevationTileDecoders.bil32,
          attribution: (L.GridLayer.Relief.elevationAttributions &&
            L.GridLayer.Relief.elevationAttributions.ignLidarHd) || '© IGN LiDAR HD',
          hillshadeAzimuth: +$('hs-azimuth').value,
          hillshadeElevation: 45,
          hillshadeExaggeration: +$('hs-exag').value,
          opacity: opacity,
          maxNativeZoom: 17,
          maxZoom: 19,
          minZoom: 13,
          tileSize: 256,
          pane: 'reliefPane'
        });
        state.reliefLayer.addTo(map);
        state.reliefMode = 'interactive';
        $('hs-azimuth').disabled = false;
        $('hs-exag').disabled = false;
        setReliefStatus('Mode interactif (WMS) — chargement lent, couverture partielle');
      } catch (err) {
        console.warn('leaflet-relief erreur → SHADOW', err);
        addShadowLayer(opacity);
      }
    } else {
      addShadowLayer(opacity);
    }

    // Appliquer filtres après un court délai (conteneur DOM créé async)
    setTimeout(applyReliefFilters, 100);
    setTimeout(applyReliefFilters, 500);
  }

  function addShadowLayer(opacity) {
    state.reliefLayer = L.tileLayer(IGN_SHADOW_URL, {
      attribution: '© IGN LiDAR HD (ombrage)',
      maxNativeZoom: 18,
      maxZoom: 19,
      minZoom: 10,
      opacity: opacity,
      pane: 'reliefPane',
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      crossOrigin: true
    });
    state.reliefLayer.addTo(map);
    state.reliefMode = 'shadow';
    $('hs-azimuth').disabled = true;
    $('hs-exag').disabled = true;
    setReliefStatus('Ombrage IGN précalculé (WMTS). Zones sans LiDAR HD = transparent.');
  }

  function setReliefStatus(msg) {
    const el = $('relief-status');
    if (el) el.textContent = msg;
  }

  function applyReliefFilters() {
    if (!state.reliefLayer) return;
    const contrast = $('hs-contrast').value;
    const brightness = $('hs-brightness').value;
    const el = state.reliefLayer.getContainer && state.reliefLayer.getContainer();
    if (el) {
      el.style.filter = `contrast(${contrast}) brightness(${brightness})`;
    }
  }

  // Opacité seule : pas de recréation de couche
  $('hs-opacity').addEventListener('input', () => {
    $('val-opacity').textContent = $('hs-opacity').value;
    if (state.reliefLayer && state.reliefLayer.setOpacity) {
      state.reliefLayer.setOpacity(+$('hs-opacity').value);
    }
  });

  // Azimut / exagération : recréer uniquement en mode interactif
  ['hs-azimuth', 'hs-exag'].forEach(id => {
    $(id).addEventListener('input', () => {
      $('val-azimuth').textContent = $('hs-azimuth').value;
      $('val-exag').textContent = $('hs-exag').value;
      if (state.reliefMode === 'interactive') createReliefLayer();
    });
  });

  ['hs-contrast', 'hs-brightness'].forEach(id => {
    $(id).addEventListener('input', () => {
      $('val-contrast').textContent = $('hs-contrast').value;
      $('val-brightness').textContent = $('hs-brightness').value;
      applyReliefFilters();
    });
  });

  if ($('relief-mode')) {
    $('relief-mode').addEventListener('change', () => createReliefLayer());
  }

  $('btn-apply-zoom').addEventListener('click', () => {
    const zmin = Math.max(13, Math.min(18, +$('zoom-min').value));
    const zmax = Math.max(zmin + 1, Math.min(19, +$('zoom-max').value));
    map.setMinZoom(zmin);
    map.setMaxZoom(zmax);
    $('zoom-min').value = zmin;
    $('zoom-max').value = zmax;
  });

  // ---------- 3. Couches géologiques ----------
  $('btn-add-layer').addEventListener('click', () => {
    const name = ($('layer-name').value || '').trim();
    if (!name) {
      alert('Indiquez un nom d\'entité (ex. silex, faille)');
      return;
    }
    if (state.geologyLayers[name]) {
      alert('Une couche avec ce nom existe déjà');
      return;
    }

    const color = $('layer-color').value;
    const weight = +$('layer-weight').value || 3;
    const group = new L.FeatureGroup();
    map.addLayer(group);

    state.geologyLayers[name] = { group, color, weight, features: [] };
    state.activeGeology = name;
    $('btn-draw-feature').disabled = false;
    renderLayersList();
    $('layer-name').value = '';
  });

  function renderLayersList() {
    const list = $('layers-list');
    list.innerHTML = '';
    Object.entries(state.geologyLayers).forEach(([name, info]) => {
      const div = document.createElement('div');
      div.className = 'layer-item';
      div.innerHTML = `
        <span class="color-swatch" style="background:${info.color}"></span>
        <span class="name" title="${name}">${name}</span>
        <button class="btn" data-act="activate" data-name="${name}">Activer</button>
        <button class="btn" data-act="delete" data-name="${name}">✕</button>
      `;
      list.appendChild(div);
    });

    list.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        if (btn.dataset.act === 'delete') {
          map.removeLayer(state.geologyLayers[name].group);
          delete state.geologyLayers[name];
          if (state.activeGeology === name) {
            state.activeGeology = null;
            $('btn-draw-feature').disabled = true;
          }
          renderLayersList();
        } else {
          state.activeGeology = name;
          $('btn-draw-feature').disabled = false;
        }
      });
    });
  }

  // Dessin d'entités géologiques : tracé manuel (ligne ou polygone)
  function addFeaturePoint(latlng) {
    featurePts.push(latlng);
    const info = state.geologyLayers[state.activeGeology];
    const m = L.circleMarker(latlng, {
      radius: 4, color: '#fff', weight: 1, fillColor: info.color, fillOpacity: 1
    }).addTo(map);
    featureMarkers.push(m);
    if (featurePolyline) map.removeLayer(featurePolyline);
    if (featurePts.length >= 2) {
      featurePolyline = L.polyline(featurePts, {
        color: info.color, weight: info.weight, dashArray: '4 4'
      }).addTo(map);
    }
  }

  function finishFeatureShape() {
    if (!state.activeGeology) return;
    const info = state.geologyLayers[state.activeGeology];
    const shapeType = ($('feature-type') && $('feature-type').value) || 'polyline';
    const minPts = shapeType === 'polygon' ? 3 : 2;
    if (featurePts.length < minPts) {
      alert(`Il faut au moins ${minPts} points.`);
      return;
    }
    const shapeOpts = {
      color: info.color,
      weight: info.weight,
      fillOpacity: shapeType === 'polygon' ? 0.25 : 0,
      opacity: 1
    };
    let layer;
    if (shapeType === 'polygon') {
      layer = L.polygon(featurePts.slice(), shapeOpts);
    } else {
      layer = L.polyline(featurePts.slice(), shapeOpts);
    }
    info.group.addLayer(layer);
    info.features.push(layer.toGeoJSON());
    stopDrawing();
  }

  $('btn-draw-feature').addEventListener('click', () => {
    if (!state.activeGeology) return;
    stopDrawing();
    drawingFeature = true;
    map.doubleClickZoom.disable();
    map.getContainer().style.cursor = 'crosshair';
    const btnFin = $('btn-finish-draw');
    if (btnFin) btnFin.style.display = '';
  });

  // ---------- 4. Export ----------
  $('btn-export').addEventListener('click', async () => {
    const format = $('export-format').value;
    const view = $('export-view').value;

    if (format === 'geojson') {
      exportGeoJSON();
    } else if (format === 'png') {
      exportPNG(view);
    } else if (format === 'gpkg') {
      alert('Export GeoPackage expérimental : utilisez GeoJSON puis convertissez avec QGIS ou ogr2ogr.\nUne bibliothèque navigateur complète est trop lourde pour cette PWA.');
      exportGeoJSON();
    }
  });

  function exportGeoJSON() {
    const features = [];
    // Zone
    if (state.zoneGeoJSON) {
      const f = JSON.parse(JSON.stringify(state.zoneGeoJSON));
      f.properties = { type: 'zone_etude', name: 'secteur' };
      features.push(f);
    }
    // Couches géologiques
    Object.entries(state.geologyLayers).forEach(([name, info]) => {
      info.group.eachLayer(layer => {
        const g = layer.toGeoJSON();
        g.properties = Object.assign({}, g.properties || {}, {
          layer: name,
          color: info.color,
          weight: info.weight
        });
        features.push(g);
      });
    });

    const fc = { type: 'FeatureCollection', features };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    downloadBlob(blob, `estran_${Date.now()}.geojson`);
  }

  function exportPNG(view) {
    // Masquer temporairement des couches selon la vue
    const hideRelief = view === 'ortho' || view === 'geology';
    const hideOrtho = view === 'relief' || view === 'geology';
    const hideGeol = view === 'ortho' || view === 'relief';

    if (hideRelief && state.reliefLayer) map.removeLayer(state.reliefLayer);
    if (hideOrtho) map.removeLayer(BASEMAPS.ortho);
    if (hideGeol) {
      Object.values(state.geologyLayers).forEach(l => map.removeLayer(l.group));
    }

    // Utiliser leaflet-image n'est pas inclus ; on passe par html2canvas-like simple
    // Approche native : canvas via leaflet (limité) – on propose un screenshot navigateur
    alert('Pour une image haute qualité de la vue actuelle :\n1. Utilisez l\'outil de capture d\'écran du navigateur (ou de l\'OS)\n2. Ou installez une extension type "GoFullPage".\n\nUn export canvas pur est limité par les tuiles CORS IGN.');

    // Restaurer
    setTimeout(() => {
      if (hideRelief && state.reliefLayer) state.reliefLayer.addTo(map);
      if (hideOrtho) BASEMAPS.ortho.addTo(map);
      if (hideGeol) Object.values(state.geologyLayers).forEach(l => l.group.addTo(map));
    }, 300);
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- Init ----------
  console.log('Estran prêt – définissez un secteur polygonal pour commencer.');
})();
