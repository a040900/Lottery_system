// 抽獎演出效果:音效(WebAudio 合成,無外部檔案)與彩帶(canvas)。皆在不支援的環境靜默略過。
export function createFx(doc) {
  const win = doc.defaultView;
  let ac;

  function audio() {
    try {
      const AC = win?.AudioContext || win?.webkitAudioContext;
      if (!AC) return null;
      ac ||= new AC();
      if (ac.state === 'suspended') ac.resume();
      return ac;
    } catch { return null; }
  }
  function beep(freq, dur, type, vol) {
    const c = audio();
    if (!c) return;
    try {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + dur);
    } catch { /* 忽略 */ }
  }

  return {
    tick(i = 0) { beep(420 + (i % 7) * 35, 0.04, 'square', 0.025); },
    count() { beep(660, 0.14, 'sine', 0.09); },
    win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.3, 'triangle', 0.09), i * 110)); },

    confetti(colors = ['#f0c45a', '#ece8df', '#faf8f9', '#f7dd9a']) {
      let canvas;
      try {
        canvas = doc.createElement('canvas');
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return;
        const W = (canvas.width = win.innerWidth);
        const H = (canvas.height = win.innerHeight);
        canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:20';
        canvas.setAttribute('aria-hidden', 'true');
        doc.body.append(canvas);
        const parts = Array.from({ length: 140 }, () => ({
          x: W / 2 + (Math.random() - 0.5) * W * 0.25, y: H * 0.42,
          vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 4,
          w: 6 + Math.random() * 7, h: 3 + Math.random() * 5, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
          c: colors[Math.floor(Math.random() * colors.length)],
        }));
        const t0 = win.performance.now();
        const step = (t) => {
          const k = (t - t0) / 2400;
          ctx.clearRect(0, 0, W, H);
          for (const p of parts) {
            p.vy += 0.38; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.r += p.vr;
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
            ctx.globalAlpha = Math.max(0, 1 - k * k);
            ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
          }
          if (k < 1) win.requestAnimationFrame(step); else canvas.remove();
        };
        win.requestAnimationFrame(step);
      } catch { canvas?.remove(); }
    },
  };
}
