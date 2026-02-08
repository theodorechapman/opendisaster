import * as THREE from "three";

export class HeatmapOverlay {
  private mesh: THREE.Mesh;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private scene: THREE.Scene;

  constructor(
    scene: THREE.Scene,
    bounds: { xMin: number; xMax: number; zMin: number; zMax: number },
    yOffset: number,
  ) {
    this.scene = scene;

    const width = bounds.xMax - bounds.xMin;
    const depth = bounds.zMax - bounds.zMin;
    const cx = (bounds.xMin + bounds.xMax) / 2;
    const cz = (bounds.zMin + bounds.zMax) / 2;

    this.canvas = document.createElement("canvas");
    this.canvas.width = 512;
    this.canvas.height = 512;
    this.ctx = this.canvas.getContext("2d")!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    const geo = new THREE.PlaneGeometry(width, depth);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(cx, yOffset, cz);
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setData(grid: Float32Array, gridWidth: number, gridHeight: number): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    let maxVal = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i]! > maxVal) maxVal = grid[i]!;
    }
    if (maxVal === 0) {
      this.texture.needsUpdate = true;
      return;
    }

    const cellW = cw / gridWidth;
    const cellH = ch / gridHeight;

    for (let row = 0; row < gridHeight; row++) {
      for (let col = 0; col < gridWidth; col++) {
        const val = grid[row * gridWidth + col]!;
        if (val <= 0) continue;
        let t = val / maxVal;
        // boost contrast so low values are still visible
        t = Math.sqrt(t);
        const color = this.heatColor(t);
        ctx.fillStyle = color;
        ctx.fillRect(col * cellW, row * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // Grid lines every 20m (10 cells at 2m cellSize)
    ctx.strokeStyle = "rgba(200,200,200,0.15)";
    ctx.lineWidth = 0.5;
    const cellsPer20m = 10;
    for (let col = 0; col <= gridWidth; col += cellsPer20m) {
      const x = col * cellW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ch);
      ctx.stroke();
    }
    for (let row = 0; row <= gridHeight; row += cellsPer20m) {
      const y = row * cellH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cw, y);
      ctx.stroke();
    }

    this.texture.needsUpdate = true;
  }

  private heatColor(t: number): string {
    // transparent(0) → blue → yellow → red(1)
    const alpha = 0.5 + t * 0.5;
    let r: number, g: number, b: number;
    if (t < 0.5) {
      const s = t / 0.5;
      r = Math.round(s * 255);
      g = Math.round(s * 255);
      b = Math.round((1 - s) * 255);
    } else {
      const s = (t - 0.5) / 0.5;
      r = 255;
      g = Math.round((1 - s) * 255);
      b = 0;
    }
    return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}
