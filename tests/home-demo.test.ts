import { expect, it } from 'vitest';
import { HOME_DEMO, homeDemoMarkup } from '../src/ui/home-demo';

it('lands between both left balls at their shared lower tangency point', () => {
  const { leftLanding: landing, leftPair, radius } = HOME_DEMO;
  expect(landing.x).toBe((leftPair[0].x + leftPair[1].x) / 2);
  expect(landing.x).toBeGreaterThan(leftPair[0].x); expect(landing.x).toBeLessThan(leftPair[1].x);
  expect(landing.y).toBeGreaterThan(leftPair[0].y);
  for (const center of leftPair) expect(Math.hypot(landing.x - center.x, landing.y - center.y)).toBeCloseTo(radius * 2, 10);
});

it('generates each SVG route endpoint and animated displacement from the same geometry', () => {
  const markup = homeDemoMarkup(true);
  for (const side of ['left', 'right'] as const) {
    const route = new RegExp(`class="demo-route-${side}" d="M([\\d.-]+) ([\\d.-]+)L([\\d.-]+) ([\\d.-]+)"`).exec(markup)!;
    const dx = Number(new RegExp(`--demo-${side}-x:([\\d.-]+)px`).exec(markup)![1]);
    const dy = Number(new RegExp(`--demo-${side}-y:([\\d.-]+)px`).exec(markup)![1]);
    expect(Number(route[1]) + dx).toBeCloseTo(Number(route[3]), 10);
    expect(Number(route[2]) + dy).toBeCloseTo(Number(route[4]), 10);
  }
  expect(markup).toContain('viewBox="0 0 320 200"'); expect(markup).toContain('轻触重播');
  expect(homeDemoMarkup(false)).toContain('点击重播');
});

it('approaches the left pair without overlap and keeps the right hanging ball tangent to both supports', () => {
  const { launch, leftLanding, leftPair, rightPair, falling, radius } = HOME_DEMO;
  for (let step = 0; step <= 100; step++) {
    const t = step / 100, point = { x: launch.x + (leftLanding.x - launch.x) * t, y: launch.y + (leftLanding.y - launch.y) * t };
    for (const target of leftPair) expect(Math.hypot(point.x - target.x, point.y - target.y)).toBeGreaterThanOrEqual(radius * 2 - 1e-9);
  }
  for (const target of rightPair) expect(Math.hypot(falling.x - target.x, falling.y - target.y)).toBeCloseTo(radius * 2, 10);
});
