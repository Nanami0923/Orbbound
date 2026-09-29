import type { Cell } from '../core/types';

export interface CampaignLevel {
  id: number;
  chapter: string;
  name: string;
  hint: string;
  layout: string[];
  seed: number;
  maxShots: number;
  silver: number;
  gold: number;
  timeLimitMs?: number;
  descentEvery?: number;
  targets?: Cell[];
}

// Dots are empty cells. Each row uses the same staggered hex grid as classic play.
export const LEGACY_CAMPAIGN_LEVELS: CampaignLevel[] = [
  { id: 1, chapter: '连接与消除', name: '初次连接', hint: '找两个连在一起的同色球，补上一球。',
    layout: ['..00..11..22..', '..00..11..22..', '...0...1...2..'], seed: 4001, maxShots: 10, silver: 6, gold: 4 },
  { id: 2, chapter: '连接与消除', name: '色彩阶梯', hint: '先打开下方，再处理上方同色球。',
    layout: ['..0011220011..', '..0011220011..', '...00112200...', '....001122....'], seed: 4002, maxShots: 14, silver: 9, gold: 6 },
  { id: 3, chapter: '连接与消除', name: '左右取舍', hint: '观察下一球，给后续颜色留好落点。',
    layout: ['.0011....2200.', '.0011....2200.', '..220....112..', '..220....112..', '...2......1..'], seed: 4003, maxShots: 14, silver: 8, gold: 5 },
  { id: 4, chapter: '连接与消除', name: '连锁回响', hint: '消除上方连接处，让下面的球一起掉落。',
    layout: ['..00..11..22..', '..00..11..22..', '..1122001122.', '..1122001122.', '...22001122..'], seed: 4004, maxShots: 12, silver: 7, gold: 4 },
  { id: 5, chapter: '拆解支撑', name: '悬挂花园', hint: '窄处是整片球群的支撑，优先观察它。',
    layout: ['...00....11...', '...00....11...', '..222...333..', '..222...333..', '...22....33..'], seed: 4005, maxShots: 14, silver: 8, gold: 4 },
  { id: 6, chapter: '拆解支撑', name: '双桥', hint: '不同球群可能共用支撑，尝试连锁拆解。',
    layout: ['..0011223300..', '..1122330011..', '..2233001122..', '..3300112233..', '...11223300..'], seed: 4006, maxShots: 24, silver: 16, gold: 11 },
  { id: 7, chapter: '拆解支撑', name: '摘下星点', hint: '白色外圈是目标球；直接消除或让它掉落都算完成。',
    layout: ['..00..11..22..', '..00..11..22..', '..33..22..11..', '..33..22..11..', '...3...2...1..'], targets: [{row:4,col:3},{row:4,col:7},{row:4,col:11}], seed: 4007, maxShots: 16, silver: 10, gold: 5 },
  { id: 8, chapter: '拆解支撑', name: '一线相连', hint: '左右两片球群有不同的支撑，先规划拆除顺序。',
    layout: ['..0011223300..', '..1122330011..', '..2233001122..', '..3300112233..', '...00112233..', '...11223300..'], seed: 4008, maxShots: 22, silver: 13, gold: 8 },
  { id: 9, chapter: '路线与空间', name: '两侧来风', hint: '沿墙反弹可以绕过正面遮挡，试着从侧面打开。',
    layout: ['00112200112233', '11223311223300', '.223300223300.', '.330011330011.', '..0011220011..', '..1122331122..'], seed: 4009, maxShots: 30, silver: 22, gold: 16 },
  { id: 10, chapter: '路线与空间', name: '步步迫近', hint: '每 6 发整体下移一行，不会补入新球。',
    layout: ['..0011223344..', '..1122334400..', '..2233440011..', '..3344001122..', '...44001122..', '...00112233..'], seed: 4010, maxShots: 24, silver: 14, gold: 8, descentEvery: 6 },
  { id: 11, chapter: '路线与空间', name: '穿过回廊', hint: '白圈球才是目标，先打通抵达它们的路线。',
    layout: ['00112233440011', '11223344001122', '.223344001122.', '.334400112233.', '..4400112233..', '..0011223344..', '...11223344..'], targets: [{row:0,col:1},{row:0,col:12}], seed: 4011, maxShots: 24, silver: 14, gold: 8 },
  { id: 12, chapter: '路线与空间', name: '最后的回响', hint: '90 秒内清空；只有可以瞄准发射时计时，动画与暂停不计时。',
    layout: ['..0011223300..', '..0011223300..', '...22330011..', '...22330011..', '....112233...', '....112233...'], seed: 4012, maxShots: 999, silver: 65000, gold: 45000, timeLimitMs: 90000 },
];

export function getLegacyLevel(id: number): CampaignLevel {
  const level = LEGACY_CAMPAIGN_LEVELS.find(level => level.id === id);
  if (!level) throw new Error('关卡不存在');
  return level;
}
