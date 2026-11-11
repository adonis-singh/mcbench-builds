(function () {
  'use strict';

  // The shared viewer's bridge (server/share-viewer.js), which BlueMap loads
  // from the viewer's settings.json: it shows the one build its address
  // names (?build=<build.json>, relative to the viewer) with the app's own
  // tile sync and mesher, and tells the share page around it when the build
  // starts to be on screen ({ type: 'mcbench-share:shown' }), how far its
  // drawing has come ({ type: 'mcbench-share:progress', drawn, total }) or
  // why it is not shown ({ type: 'mcbench-share:failed', error }). There is no live world, no
  // selection and no player mode: a visitor moves the camera with BlueMap's
  // own controls. Every address is relative to the viewer, which GitHub
  // Pages serves under /<repo>/.
  function tell(message) {
    window.parent.postMessage(message, window.location.origin);
  }
  // The share page knows from this that the viewer runs.
  tell({ type: 'mcbench-share:loading' });

  function here(name) {
    return new URL(name, document.baseURI).href;
  }

  function waitForBlueMap() {
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      var timer = setInterval(function () {
        if (window.bluemap && window.bluemap.mapViewer && window.bluemap.mapViewer.map?.isLoaded && window.BlueMap) {
          clearInterval(timer);
          resolve(window.bluemap);
        } else if (Date.now() - started > 20000) {
          clearInterval(timer);
          reject(new Error('BlueMap viewer did not become ready'));
        }
      }, 16);
    });
  }

  async function json(url) {
    var response = await fetch(url);
    if (!response.ok) throw new Error(url + ' is unavailable (HTTP ' + response.status + ')');
    return response.json();
  }

  // BlueMap's own menus and buttons are made for a full window; the share
  // fills a 480 px frame or a phone, so only the map shows. Its controls
  // are on the map itself: drag to move, right drag or two fingers to
  // rotate and tilt, wheel or pinch to zoom.
  function hideChrome() {
    var style = document.createElement('style');
    style.textContent = '#app{display:none!important}html,body{overscroll-behavior:none}';
    document.head.appendChild(style);
  }

  // The opening view: the preview's (server/shot.js iso_se), from the
  // south-east, 30 degrees below the horizon, at the distance the preview
  // takes to keep all 8 corners of the build's box in this frame with
  // MARGIN to spare, the box's picture centered in it. BlueMap's map camera looks along its
  // heading (sin rotation, 0, -cos rotation), turned down from straight down
  // by `angle`, at a target `distance` ahead.
  var ROTATION = -Math.PI / 4;
  var ANGLE = Math.PI / 2 - Math.PI / 6;
  var MARGIN = 1.08;
  function opening(build, camera) {
    var min = build.bounds.min;
    var max = build.bounds.max;
    var dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    var heading = [Math.sin(ROTATION), 0, -Math.cos(ROTATION)];
    var forward = [heading[0] * Math.sin(ANGLE), -Math.cos(ANGLE), heading[2] * Math.sin(ANGLE)];
    var right = [Math.cos(ROTATION), 0, Math.sin(ROTATION)];
    var up = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ];
    var tall = Math.tan(camera.fov * Math.PI / 360) / MARGIN;
    var wide = tall * camera.aspect;
    var corners = [];
    for (var corner = 0; corner < 8; corner += 1) {
      corners.push([0, 1, 2].map(function (i) { return corner >> i & 1 ? max[i] + 1 : min[i]; }));
    }
    // As the preview frames it: the nearest eye on the line through the
    // box's center that sees every corner, a corner at x along right (or
    // up) and f along forward from the center being in view when
    // |x| <= k (distance + f), k the frame's half width (or height) per unit
    // of depth.
    var center = [0, 1, 2].map(function (i) { return (min[i] + max[i] + 1) / 2; });
    var depth = dot(center, forward) - Math.max.apply(null, corners.map(function (p) {
      var offset = [0, 1, 2].map(function (i) { return p[i] - center[i]; });
      return Math.max(Math.abs(dot(offset, right)) / wide, Math.abs(dot(offset, up)) / tall) - dot(offset, forward);
    }));
    // Perspective draws the near part of the box larger, so that picture
    // sits off the middle of the frame. The eye moves across, at the same
    // depth e (the same perspective), until the corners are as far out on
    // one side as on the other: that spread falls as the eye's c along the
    // axis grows, so halving the range in which every corner stays in view
    // finds it. An empty range: no eye at that depth sees every corner.
    var range = function (direction, k, e) {
      return [
        Math.max.apply(null, corners.map(function (p) { return dot(p, direction) - k * (dot(p, forward) - e); })),
        Math.min.apply(null, corners.map(function (p) { return dot(p, direction) + k * (dot(p, forward) - e); })),
      ];
    };
    var middle = function (direction, k, e) {
      var bounds = range(direction, k, e);
      for (var step = 0; step < 50; step += 1) {
        var c = (bounds[0] + bounds[1]) / 2;
        var seen = corners.map(function (p) { return (dot(p, direction) - c) / (dot(p, forward) - e); });
        if (Math.max.apply(null, seen) + Math.min.apply(null, seen) > 0) bounds[0] = c;
        else bounds[1] = c;
      }
      return (bounds[0] + bounds[1]) / 2;
    };
    // Centered, the picture has room on every side, so the eye comes nearer
    // in steps of 2% while every corner stays in view and the build's near
    // end is drawn at most five times the scale of its far end (the preview
    // draws a wide flat build at about four): nearer still, a flat build
    // fits the frame only by swelling its near corner, and BlueMap's 75
    // degree view would reach that with the eye a few blocks off it.
    var fits = function (e) {
      var depths = corners.map(function (p) { return dot(p, forward) - e; });
      var across = range(right, wide, e);
      var down = range(up, tall, e);
      return across[0] <= across[1] && down[0] <= down[1] && 5 * Math.min.apply(null, depths) >= Math.max.apply(null, depths);
    };
    var ahead = dot(center, forward);
    for (var steps = 0; steps < 100 && fits(ahead - (ahead - depth) * 0.98); steps += 1) depth = ahead - (ahead - depth) * 0.98;
    var eye = [0, 1, 2].map(function (i) { return right[i] * middle(right, wide, depth) + up[i] * middle(up, tall, depth) + forward[i] * depth; });
    // The target is where the eye's line of sight meets the build's middle
    // height.
    var height = (min[1] + max[1] + 1) / 2;
    var distance = (eye[1] - height) / -forward[1];
    return { target: eye.map(function (value, i) { return value + forward[i] * distance; }), distance: distance };
  }

  // The camera's target stays at the opening height and over the build's
  // box, wherever a visitor drags it: the world holds this build alone, and
  // BlueMap's own rule (3 blocks over the terrain under the target, lowered
  // toward y 0 as the camera backs off) sinks it into the void beside the
  // build. Zooming out stops at a few times the opening distance.
  function holdCamera(app, build, view) {
    var low = [Math.min(build.bounds.min[0], view.target[0]), Math.min(build.bounds.min[2], view.target[2])];
    var high = [Math.max(build.bounds.max[0] + 1, view.target[0]), Math.max(build.bounds.max[2] + 1, view.target[2])];
    var clamp = function (value, a, b) { return Math.min(Math.max(value, a), b); };
    app.mapControls.maxDistance = view.distance * 4;
    app.mapControls.mapHeight.update = function () {
      var position = this.manager.position;
      position.x = clamp(position.x, low[0], high[0]);
      position.z = clamp(position.z, low[1], high[1]);
      position.y = view.target[1];
    };
  }

  // How far drawing has come, for the share page's progress line: the
  // build's tiles (the tile sync's) and how many of them BlueMap has on
  // screen, told after each tile it loads until every one is.
  function tellProgress(app, sync) {
    function count() {
      var drawn = 0;
      sync.assets.forEach(function (asset, key) {
        var tile = sync.manager.tiles.get(key);
        if (tile && tile.loaded) drawn += 1;
      });
      tell({ type: 'mcbench-share:progress', drawn: drawn, total: sync.assets.size });
      if (drawn === sync.assets.size) app.events.removeEventListener('bluemapMapTileLoaded', count);
    }
    app.events.addEventListener('bluemapMapTileLoaded', count);
    count();
  }

  var buildUrl = new URL(new URLSearchParams(window.location.search).get('build'), window.location.href);

  Promise.all([waitForBlueMap(), json(buildUrl.href), import(here('bluemap-tiles.mjs')), import(here('bluemap-view.mjs'))])
    .then(async function (loaded) {
      var app = loaded[0];
      var build = loaded[1];
      var tiles = loaded[2];
      hideChrome();
      var spawn = function () { return new Worker(here('mesher-worker.mjs'), { type: 'module' }); };
      var sync = new tiles.BlueMapTileSync(app, new tiles.MesherClient(spawn, tiles.MesherClient.poolSize(navigator.hardwareConcurrency)));
      // The camera is held by holdCamera, not by the terrain under it.
      loaded[3].patchViewer(app, function () { return null; });
      var view = opening(build, app.mapViewer.camera);
      holdCamera(app, build, view);
      window.location.replace('#' + [app.mapViewer.map.data.id].concat(view.target.map(function (value) { return value.toFixed(2); }), [view.distance.toFixed(2), ROTATION.toFixed(4), ANGLE.toFixed(4), 0, 0, 'perspective']).join(':'));
      await sync.refresh({
        blueprint: new URL(build.blueprint, buildUrl).href,
        mask: build.mask,
        wasm: here('mesher.wasm.gz'),
        pack: here('mcbench-pack.bin.gz'),
      }, { fresh: true });
      // The tile sync's refresh ends once the first tile is on screen; the
      // rest stream in nearest first.
      tell({ type: 'mcbench-share:shown' });
      tellProgress(app, sync);
    })
    .catch(function (error) {
      tell({ type: 'mcbench-share:failed', error: String(error.message || error) });
    });
})();
