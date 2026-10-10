import { useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { Ref } from 'react';
import type { WheelSegment } from '@contract/api.ts';
import { t } from '../i18n.ts';
import { haptic } from '../telegram.ts';

export interface WheelHandle {
  /** Начать вращение, пока сервер определяет результат */
  start(): void;
  /** Плавно остановиться на сегменте с указанным индексом */
  stopAt(index: number): Promise<void>;
  /** Плавно остановиться без результата (ошибка запроса) */
  abort(): Promise<void>;
}

export const WHEEL_COLORS: [fill: string, text: string][] = [
  ['#00d4ff', '#0a0015'],
  ['#3a0f75', '#ffffff'],
  ['#ffd700', '#0a0015'],
  ['#1e1038', '#00d4ff'],
  ['#7b2fbe', '#ffffff'],
  ['#ff6b00', '#0a0015'],
  ['#00e676', '#0a0015'],
  ['#ff4455', '#ffffff'],
];

const C = 100;
const R = 94;
const MAX_SPEED = 780; // градусов в секунду
const ACCELERATION = 1500;
const point = (deg: number, r = R) => {
  const a = (deg * Math.PI) / 180;
  return `${(C + r * Math.sin(a)).toFixed(3)} ${(C - r * Math.cos(a)).toFixed(3)}`;
};
const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;

function label(segment: WheelSegment): string[] {
  if (segment.type === 'PERCENT_DISCOUNT' && segment.value) return [`−${Number(segment.value)}%`];
  const words = segment.name.split(' ');
  if (segment.name.length <= 11 || words.length === 1) return [segment.name];
  // Делим название на две строки примерно пополам.
  let best = 1;
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(' ').length;
    if (
      Math.abs(left - segment.name.length / 2) <
      Math.abs(words.slice(0, best).join(' ').length - segment.name.length / 2)
    )
      best = i;
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

export function Wheel({
  segments,
  state,
  hub,
  ref,
}: {
  segments: WheelSegment[];
  state: 'idle' | 'spinning' | 'locked';
  hub: string;
  ref: Ref<WheelHandle>;
}) {
  const rotor = useRef<SVGGElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
  const motion = useRef({
    angle: 0,
    speed: 0,
    phase: 'idle' as 'idle' | 'accelerate' | 'settle',
    from: 0,
    to: 0,
    startedAt: 0,
    duration: 0,
    last: 0,
    frame: 0,
    lastTick: 0,
    done: null as null | (() => void),
  });
  const step = 360 / segments.length;

  useEffect(() => () => cancelAnimationFrame(motion.current.frame), []);

  useImperativeHandle(ref, () => {
    const m = motion.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tick = (now: number) => {
      const dt = Math.min((now - m.last) / 1000, 0.05);
      m.last = now;
      const before = m.angle;
      if (m.phase === 'accelerate') {
        m.speed = Math.min(MAX_SPEED, m.speed + ACCELERATION * dt);
        m.angle += m.speed * dt;
      } else if (m.phase === 'settle') {
        const p = Math.min((now - m.startedAt) / m.duration, 1);
        m.angle = m.from + (m.to - m.from) * easeOutCubic(p);
        if (p >= 1) m.phase = 'idle';
      }
      if (rotor.current) rotor.current.style.transform = `rotate(${m.angle}deg)`;

      // «Щелчок» указателя при проходе границы сегмента.
      if (Math.floor(before / step) !== Math.floor(m.angle / step) && now - m.lastTick > 70) {
        m.lastTick = now;
        haptic.tick();
        const el = pointer.current;
        if (el) {
          el.classList.remove('kick');
          void el.offsetWidth;
          el.classList.add('kick');
        }
      }
      if (m.phase === 'idle') {
        m.speed = 0;
        m.done?.();
        m.done = null;
        return;
      }
      m.frame = requestAnimationFrame(tick);
    };

    const settle = (target: number | null) =>
      new Promise<void>((resolve) => {
        const duration = reduced ? 700 : 4600;
        // Начальная скорость easeOutCubic равна 3·Δ/T — подбираем Δ под текущую скорость, чтобы не было рывка.
        const natural = Math.max((m.speed * duration) / 1000 / 3, reduced ? 0 : 720);
        let to = m.angle + natural;
        if (target !== null) to += (((target - to) % 360) + 360) % 360;
        Object.assign(m, {
          phase: 'settle',
          from: m.angle,
          to,
          startedAt: performance.now(),
          duration,
          done: resolve,
        });
        if (!m.frame || m.speed === 0) {
          m.last = performance.now();
          m.frame = requestAnimationFrame(tick);
        }
      });

    return {
      start() {
        cancelAnimationFrame(m.frame);
        Object.assign(m, { phase: 'accelerate', speed: reduced ? MAX_SPEED : 0, last: performance.now() });
        m.frame = requestAnimationFrame(tick);
      },
      stopAt(index) {
        // Центр сегмента должен оказаться под указателем (вверху), с небольшим случайным смещением внутри сегмента.
        const centre = (index + 0.5) * step + (Math.random() - 0.5) * step * 0.56;
        return settle(-centre);
      },
      abort: () => settle(null),
    };
  }, [step]);

  const drawn = useMemo(
    () =>
      segments.map((segment, i) => {
        const [fill, text] = WHEEL_COLORS[i % WHEEL_COLORS.length]!;
        const from = i * step;
        const to = from + step;
        const lines = label(segment);
        const big = lines.length === 1 && lines[0]!.length <= 5;
        const mid = from + step / 2;
        const x = C + R * 0.66;
        // На левой половине колеса подпись разворачивается, чтобы не читаться вверх ногами.
        const flip = mid > 180 ? ` rotate(180 ${x} ${C})` : '';
        const size = big
          ? segments.length > 8
            ? 11
            : 14
          : segments.length > 8
            ? 5.4
            : segments.length > 6
              ? 6.2
              : 7;
        return (
          <g key={segment.prizeId}>
            <path d={`M${C} ${C} L${point(from)} A${R} ${R} 0 0 1 ${point(to)} Z`} fill={fill} />
            <g transform={`rotate(${mid - 90} ${C} ${C})${flip}`}>
              <text
                x={x}
                y={C}
                fill={text}
                fontSize={size}
                fontWeight={big ? 700 : 800}
                fontFamily={big ? 'var(--font-display)' : 'var(--font-body)'}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {lines.map((line, n) => (
                  <tspan key={n} x={x} dy={n === 0 ? `${-(lines.length - 1) * 0.58}em` : '1.16em'}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          </g>
        );
      }),
    [segments, step],
  );

  return (
    <div className={`wheel-stage ${state}`}>
      <div className="wheel-glow" />
      <div className="wheel-pointer" ref={pointer}>
        <svg viewBox="0 0 34 42" width="34" height="42">
          <path d="M17 41 3.5 14A14.5 14.5 0 1 1 30.5 14z" fill="#ffd700" />
          <circle cx="17" cy="14" r="5" fill="#0a0015" />
        </svg>
      </div>
      <svg className="wheel-svg" viewBox="0 0 200 200" role="img" aria-label={t('roulette.wheelAria')}>
        <defs>
          <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffd700" />
            <stop offset="0.5" stopColor="#fff3a8" />
            <stop offset="1" stopColor="#ffd700" />
          </linearGradient>
        </defs>
        <circle cx={C} cy={C} r="99" fill="url(#rim)" />
        <circle cx={C} cy={C} r="96.5" fill="#0a0015" />
        <g className="wheel-rotor" ref={rotor}>
          {drawn}
          {segments.map((s, i) => {
            const [x, y] = point(i * step, R - 3.5).split(' ');
            return <circle key={s.prizeId} cx={x} cy={y} r="1.9" fill="#fff" opacity="0.92" />;
          })}
        </g>
      </svg>
      <div className="wheel-hub">{hub}</div>
    </div>
  );
}
