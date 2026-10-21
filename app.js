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
    center: [48.4, -4.5],   // Bretagne / Finistère – zone d'estran typique
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

  // ---------- 1. Dessin de la zone ----------
  let activeDrawHandler = null;

  function stopDrawing() {
    if (activeDrawHandler) {
      activeDrawHandler.disable();
      activeDrawHandler = null;
    }
    map.off(L.Draw.Event.CREATED);
  }

  $('btn-draw-zone').addEventListener('click', () => {
    stopDrawing();

    const polygonOptions = {
      allowIntersection: false,
      showArea: true,
      shapeOptions: { color: '#e94560', weight: 2, fillOpacity: 0.15 },
      guidelineDistance: 10,
      metric: true
    };

    activeDrawHandler = new L.Draw.Polygon(map, polygonOptions);
    activeDrawHandler.enable();

    $('zone-info').textContent = 'Cliquez sur la carte pour tracer le polygone. Double-clic (ou clic sur le 1er point) pour terminer.';
    $('zone-info').classList.remove('active');

    map.once(L.Draw.Event.CREATED, onZoneCreated);
  });

  function onZoneCreated(e) {
    activeDrawHandler = null;
    const layer = e.layer;
    const geo = layer.toGeoJSON();
    const length = estimateLength(geo);

    if (length > 1100) {
      alert(`Le secteur fait environ ${Math.round(length)} m de long. Maximum autorisé : 1 000 m.`);
      map.removeLayer(layer);
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

    $('zone-info').textContent = `Secteur défini – longueur ≈ ${Math.round(length)} m`;
    $('zone-info').classList.add('active');
    $('btn-clear-zone').disabled = false;
    $('btn-draw-zone').disabled = true;

    enterRestrictedMode();
  }

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

  function createReliefLayer() {
    if (state.reliefLayer) map.removeLayer(state.reliefLayer);

    const opts = {
      mode: 'hillshade',
      elevationUrl: L.GridLayer.Relief.elevationUrls.ignLidarHdMnt,
      elevationTileDecoder: L.GridLayer.Relief.elevationTileDecoders.bil32,
      attribution: L.GridLayer.Relief.elevationAttributions.ignLidarHd,
      hillshadeAzimuth: +$('hs-azimuth').value,
      hillshadeElevation: 45,
      hillshadeExaggeration: +$('hs-exag').value,
      opacity: +$('hs-opacity').value,
      maxNativeZoom: 18,
      maxZoom: 19,
      minZoom: 13,
      zIndex: 200
    };

    state.reliefLayer = L.gridLayer.relief(opts);
    state.reliefLayer.addTo(map);

    // Appliquer contraste / luminosité via CSS filter sur le conteneur
    applyReliefFilters();
  }

  function applyReliefFilters() {
    if (!state.reliefLayer) return;
    const contrast = $('hs-contrast').value;
    const brightness = $('hs-brightness').value;
    // Leaflet GridLayer utilise des canvas ; on cible le pane
    const pane = map.getPane('tilePane') || document.querySelector('.leaflet-tile-pane');
    // On applique le filtre sur les tuiles du relief uniquement si possible
    // Approche simple : filtre sur le conteneur de la couche
    const el = state.reliefLayer.getContainer && state.reliefLayer.getContainer();
    if (el) {
      el.style.filter = `contrast(${contrast}) brightness(${brightness})`;
    }
  }

  // Sliders hillshade
  ['hs-opacity', 'hs-azimuth', 'hs-exag'].forEach(id => {
    $(id).addEventListener('input', () => {
      $('val-opacity').textContent = $('hs-opacity').value;
      $('val-azimuth').textContent = $('hs-azimuth').value;
      $('val-exag').textContent = $('hs-exag').value;
      // Recréer la couche pour azimuth / exaggeration (le plugin ne les met pas à jour à chaud)
      createReliefLayer();
    });
  });

  ['hs-contrast', 'hs-brightness'].forEach(id => {
    $(id).addEventListener('input', () => {
      $('val-contrast').textContent = $('hs-contrast').value;
      $('val-brightness').textContent = $('hs-brightness').value;
      applyReliefFilters();
    });
  });

  $('hs-opacity').addEventListener('input', () => {
    if (state.reliefLayer) state.reliefLayer.setOpacity(+$('hs-opacity').value);
  });

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

  // Dessin d'entités géologiques : polyligne ou polygone
  $('btn-draw-feature').addEventListener('click', () => {
    if (!state.activeGeology) return;
    stopDrawing();

    const info = state.geologyLayers[state.activeGeology];
    const shapeType = ($('feature-type') && $('feature-type').value) || 'polyline';

    const shapeOpts = {
      color: info.color,
      weight: info.weight,
      fillOpacity: shapeType === 'polygon' ? 0.25 : 0,
      opacity: 1
    };

    if (shapeType === 'polygon') {
      activeDrawHandler = new L.Draw.Polygon(map, {
        allowIntersection: false,
        shapeOptions: shapeOpts
      });
    } else {
      activeDrawHandler = new L.Draw.Polyline(map, {
        shapeOptions: shapeOpts
      });
    }
    activeDrawHandler.enable();

    map.once(L.Draw.Event.CREATED, (e) => {
      activeDrawHandler = null;
      const layer = e.layer;
      layer.setStyle(shapeOpts);
      info.group.addLayer(layer);
      info.features.push(layer.toGeoJSON());
    });
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
