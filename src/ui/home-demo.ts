import './home-demo.css';

const radius = 14;
const launch = { x: 160, y: 165 };
const leftPair = [{ x: 80, y: 40 }, { x: 108, y: 40 }] as const;
const rightPair = [{ x: 240, y: 40 }, { x: 268, y: 40 }] as const;
const beneathPair = (pair: readonly [{ x: number; y: number }, { x: number; y: number }]) => ({
  x: (pair[0].x + pair[1].x) / 2,
  y: pair[0].y + Math.sqrt((radius * 2) ** 2 - ((pair[1].x - pair[0].x) / 2) ** 2),
});

/** Fixed explanatory geometry, independent of the game's collision and snapping rules. */
export const HOME_DEMO = {
  radius, launch, leftPair, rightPair,
  leftLanding: beneathPair(leftPair),
  rightLanding: { x: rightPair[0].x - radius * 2, y: rightPair[0].y },
  falling: beneathPair(rightPair),
} as const;

export function homeDemoMarkup(touch: boolean): string {
  const { launch: from, leftLanding: left, rightLanding: right, falling } = HOME_DEMO;
  const pair = (points: typeof leftPair | typeof rightPair, color: string, symbol: string, className: string) =>
    `<g class="${className}" fill="${color}">${points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="${radius}"/>`).join('')}<g fill="#182239" font-size="13" text-anchor="middle">${points.map(point => `<text x="${point.x}" y="${point.y + 5}">${symbol}</text>`).join('')}</g></g>`;
  const shot = (side: string, color: string, symbol: string) => `<g class="demo-shot demo-shot-${side}"><circle cx="${from.x}" cy="${from.y}" r="${radius}" fill="${color}"/><text x="${from.x}" y="${from.y + 5}" fill="#182239" font-size="13" text-anchor="middle">${symbol}</text></g>`;
  return `<button class="mechanism-demo" type="button" aria-label="${touch ? '轻触' : '点击'}重播：中心向左发射展示同色消除，向右发射展示消除后掉落">
    <svg viewBox="0 0 320 200" aria-hidden="true" style="--demo-left-x:${left.x - from.x}px;--demo-left-y:${left.y - from.y}px;--demo-right-x:${right.x - from.x}px;--demo-right-y:${right.y - from.y}px">
      <g class="demo-orbits" fill="none" stroke="currentColor"><path d="M-30 120 Q150 -80 350 95"/><path d="M-10 160 Q160 20 340 155"/></g>
      <path class="demo-route-left" d="M${from.x} ${from.y}L${left.x} ${left.y}"/><path class="demo-route-right" d="M${from.x} ${from.y}L${right.x} ${right.y}"/>
      ${pair(leftPair, '#63d7bd', '◆', 'demo-match-left')}${pair(rightPair, '#f6c85f', '✦', 'demo-match-right')}
      <g class="demo-falling"><circle cx="${falling.x}" cy="${falling.y}" r="${radius}" fill="#ff777b"/><text x="${falling.x}" y="${falling.y + 5}" fill="#182239" font-size="13" text-anchor="middle">●</text></g>
      <circle cx="${from.x}" cy="${from.y}" r="20" fill="#172238" stroke="#64718d" stroke-opacity=".6"/>
      ${shot('left', '#63d7bd', '◆')}${shot('right', '#f6c85f', '✦')}
      <g fill="#a7b4c9" font-size="10" text-anchor="middle"><text x="87" y="190">同色消除</text><text x="260" y="190">消除后掉落</text></g>
    </svg><span>从中心出发，${touch ? '轻触' : '点击'}重播</span>
  </button>`;
}
