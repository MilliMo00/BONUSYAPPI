import { useEffect, useRef } from 'react';

const COLORS = ['#00d4ff', '#7b2fbe', '#ffd700', '#ff6b00', '#00e676', '#ffffff'];

/** Короткий салют из конфетти поверх экрана. */
export function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = (canvas.width = window.innerWidth * dpr);
    const h = (canvas.height = window.innerHeight * dpr);
    const pieces = Array.from({ length: 110 }, () => {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
      const speed = (7 + Math.random() * 11) * dpr;
      return {
        x: w / 2,
        y: h * 0.42,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: (5 + Math.random() * 6) * dpr,
        spin: Math.random() * Math.PI,
        vs: (Math.random() - 0.5) * 0.4,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      };
    });
    let frame = 0;
    const started = performance.now();
    const draw = (now: number) => {
      const life = (now - started) / 2600;
      ctx.clearRect(0, 0, w, h);
      if (life >= 1) return;
      ctx.globalAlpha = Math.min(1, (1 - life) * 2.2);
      for (const p of pieces) {
        p.vy += 0.32 * dpr;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.spin += p.vs;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <canvas ref={ref} className="confetti" />;
}
