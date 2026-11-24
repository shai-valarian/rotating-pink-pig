/* Rotating Pig. Dependency-free canvas port of the original C renderer.
 * The original mesh, camera, lighting, ASCII ramp, and pink palette are retained.
 * MIT license.
 */
(() => {
  "use strict";

  const canvas = document.getElementById("pig");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;

  const background = "#0f111a";
  const palette = [
    [245, 155, 181, ""],
    [241, 112, 151, ""],
    [224, 88, 132, ""],
    [45, 27, 44, "@"],
    [91, 54, 71, "#"],
    [255, 244, 240, "O"],
    [255, 255, 255, "*"]
  ];
  const ramp = ".:-=+*#%@";
  const elevationCos = Math.cos(0.18);
  const elevationSin = Math.sin(0.18);
  const atlas = document.createElement("canvas");
  const atlasContext = atlas.getContext("2d");
  const fontFamily = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

  let vertices;
  let materials;
  let projected;
  let triangleCount = 0;
  let columns = 0;
  let rows = 0;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let cellWidth = 0;
  let cellHeight = 0;
  let atlasCellWidth = 0;
  let atlasCellHeight = 0;
  let offsetX = 0;
  let offsetY = 0;
  let depths;
  let glyphs;
  let angle = -25 * Math.PI / 180;
  let paused = false;
  let lastTime = 0;
  let lastDraw = 0;
  let needsDraw = true;

  function buildAtlas(fontSize) {
    atlasCellWidth = Math.ceil(cellWidth * pixelRatio);
    atlasCellHeight = Math.ceil(cellHeight * pixelRatio);
    atlas.width = atlasCellWidth * 9;
    atlas.height = atlasCellHeight * palette.length;
    atlasContext.font = `${fontSize * pixelRatio}px ${fontFamily}`;
    atlasContext.textAlign = "center";
    atlasContext.textBaseline = "middle";
    for (let material = 0; material < palette.length; material++) {
      const color = palette[material];
      for (let shade = 0; shade < 9; shade++) {
        const brightness = 0.42 + 0.58 * shade / 8;
        atlasContext.fillStyle = `rgb(${Math.floor(color[0] * brightness)},${Math.floor(color[1] * brightness)},${Math.floor(color[2] * brightness)})`;
        atlasContext.fillText(
          color[3] || ramp[shade],
          (shade + 0.5) * atlasCellWidth,
          (material + 0.5) * atlasCellHeight
        );
      }
    }
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    // Preserve the original terminal-cell aspect ratio at every viewport size.
    const fontSize = Math.max(9, Math.min(16, width / 78 / 0.6), width / 180 / 0.6, height * 0.48 / 96 / 0.6);
    cellWidth = fontSize * 0.6;
    cellHeight = cellWidth / 0.48;
    columns = Math.max(1, Math.floor(width / cellWidth));
    rows = Math.max(1, Math.floor(height / cellHeight));
    offsetX = (width - columns * cellWidth) / 2;
    offsetY = (height - rows * cellHeight) / 2;
    depths = new Float32Array(columns * rows);
    glyphs = new Uint8Array(columns * rows);
    buildAtlas(fontSize);
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    needsDraw = true;
  }

  async function loadMesh() {
    const response = await fetch(new URL("./mesh.bin", document.baseURI));
    if (!response.ok) throw new Error(`Could not load pig mesh (${response.status}).`);
    const data = await response.arrayBuffer();
    if (data.byteLength < 4) throw new Error("Pig mesh is incomplete.");
    const view = new DataView(data);
    triangleCount = view.getUint32(0, true);
    if (triangleCount < 1 || triangleCount > 50000 || data.byteLength !== 4 + triangleCount * 76) {
      throw new Error("Pig mesh has an invalid size.");
    }
    vertices = new Float32Array(triangleCount * 18);
    projected = new Float32Array(vertices.length);
    materials = new Uint8Array(triangleCount);
    let position = 4;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      for (let component = 0; component < 18; component++) {
        vertices[triangle * 18 + component] = view.getFloat32(position, true);
        position += 4;
      }
      const material = view.getUint32(position, true);
      position += 4;
      if (material >= palette.length) throw new Error("Pig mesh has an invalid material.");
      materials[triangle] = material;
    }
    needsDraw = true;
  }

  function projectMesh() {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const zoom = Math.max(0.1, Math.min((columns - 4) / 5.8, (rows - 2) / 1.93));
    for (let i = 0; i < vertices.length; i += 6) {
      const x = vertices[i];
      const y = vertices[i + 1];
      const z = vertices[i + 2];
      const rotatedX = c * x + s * z;
      const rotatedZ = -s * x + c * z;
      const cameraY = elevationCos * y - elevationSin * rotatedZ;
      const cameraZ = elevationSin * y + elevationCos * rotatedZ;
      const perspective = 8.7 / (8.7 - cameraZ);
      projected[i] = columns * 0.5 + rotatedX * zoom * perspective;
      projected[i + 1] = rows * 0.5 - cameraY * zoom * 0.48 * perspective;
      projected[i + 2] = cameraZ;

      const nx = vertices[i + 3];
      const ny = vertices[i + 4];
      const nz = vertices[i + 5];
      const rotatedNormalZ = -s * nx + c * nz;
      projected[i + 3] = c * nx + s * nz;
      projected[i + 4] = elevationCos * ny - elevationSin * rotatedNormalZ;
      projected[i + 5] = elevationSin * ny + elevationCos * rotatedNormalZ;
    }
  }

  function rasterize() {
    depths.fill(-1e10);
    glyphs.fill(0);
    const p = projected;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const i = triangle * 18;
      const ax = p[i], ay = p[i + 1];
      const bx = p[i + 6], by = p[i + 7];
      const cx = p[i + 12], cy = p[i + 13];
      const area = (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
      if (Math.abs(area) < 1e-8) continue;
      const xmin = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const xmax = Math.min(columns - 1, Math.ceil(Math.max(ax, bx, cx)));
      const ymin = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const ymax = Math.min(rows - 1, Math.ceil(Math.max(ay, by, cy)));
      const inverseArea = 1 / area;
      const material = materials[triangle];
      for (let y = ymin; y <= ymax; y++) {
        const py = y + 0.5;
        for (let x = xmin; x <= xmax; x++) {
          const px = x + 0.5;
          const w0 = ((px - bx) * (cy - by) - (py - by) * (cx - bx)) * inverseArea;
          const w1 = ((px - cx) * (ay - cy) - (py - cy) * (ax - cx)) * inverseArea;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.00001 || w1 < -0.00001 || w2 < -0.00001) continue;
          const depth = w0 * p[i + 2] + w1 * p[i + 8] + w2 * p[i + 14];
          const pixel = y * columns + x;
          if (depth <= depths[pixel]) continue;
          const nx = w0 * p[i + 3] + w1 * p[i + 9] + w2 * p[i + 15];
          const ny = w0 * p[i + 4] + w1 * p[i + 10] + w2 * p[i + 16];
          const nz = w0 * p[i + 5] + w1 * p[i + 11] + w2 * p[i + 17];
          const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
          const diffuse = length > 1e-10 ? Math.max(0, (-0.36 * nx + 0.72 * ny + 0.593 * nz) / length) : 0.72;
          const shade = Math.min(8, Math.max(0, Math.floor((0.22 + 0.78 * diffuse) * 8)));
          depths[pixel] = depth;
          glyphs[pixel] = material * 9 + shade + 1;
        }
      }
    }
  }

  function draw() {
    projectMesh();
    rasterize();
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const glyph = glyphs[y * columns + x];
        if (!glyph) continue;
        const index = glyph - 1;
        context.drawImage(
          atlas,
          (index % 9) * atlasCellWidth,
          Math.floor(index / 9) * atlasCellHeight,
          atlasCellWidth, atlasCellHeight,
          offsetX + x * cellWidth, offsetY + y * cellHeight,
          cellWidth, cellHeight
        );
      }
    }
  }

  function animate(time) {
    requestAnimationFrame(animate);
    if (document.hidden || !vertices) {
      lastTime = 0;
      return;
    }
    if (lastTime && !paused) angle = (angle + Math.min((time - lastTime) / 1000, 0.1) * 0.72) % (Math.PI * 2);
    lastTime = time;
    if (!needsDraw && (paused || time - lastDraw < 1000 / 30)) return;
    draw();
    lastDraw = time;
    needsDraw = false;
  }

  function togglePause() {
    paused = !paused;
    lastTime = 0;
  }

  canvas.addEventListener("click", togglePause);
  window.addEventListener("keydown", event => {
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      togglePause();
    }
  });
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", () => { lastTime = 0; });
  resize();
  loadMesh().catch(error => console.error(error));
  requestAnimationFrame(animate);
})();
