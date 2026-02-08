import { useEffect, useRef } from "react";

export function NoiseCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf: number;
    let t = 0;

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    function draw() {
      const w = canvas!.width;
      const h = canvas!.height;
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const step = 4; // skip pixels for performance
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          // Dithered wave noise
          const wave = Math.sin((x + t * 0.8) * 0.015) * Math.cos((y + t * 0.5) * 0.012) * 0.5 + 0.5;
          const noise = Math.random() * 0.3;
          const v = Math.floor((wave * 0.15 + noise * 0.08) * 255);
          // Fill the step x step block
          for (let dy = 0; dy < step && y + dy < h; dy++) {
            for (let dx = 0; dx < step && x + dx < w; dx++) {
              const i = ((y + dy) * w + (x + dx)) * 4;
              d[i] = v;
              d[i + 1] = v;
              d[i + 2] = v;
              d[i + 3] = 255;
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      t += 1;
      raf = requestAnimationFrame(draw);
    }
    draw();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        pointerEvents: "none",
      }}
    />
  );
}
