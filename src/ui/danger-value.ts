export interface DangerValueParts {
  number: string;
  unit: string;
}

/** Extract a numeric shot countdown for the Android HUD without changing its spoken label. */
export function dangerValueParts(label: string): DangerValueParts | null {
  const match = label.match(/(?:再发射 |剩余 )?(\d+)( 次| 发)$/);
  return match ? { number: match[1], unit: match[2].trim() } : null;
}
