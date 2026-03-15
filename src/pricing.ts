/**
 * Pool heat pricing and target temps by month.
 * Based on Brady's guest email template.
 *
 * April / October: $150/day ($750/week) → 80°F
 * May / September: $125/day ($625/week) → 82°F
 * June / July / August: $95/day ($475/week) → 84°F
 */

interface SeasonConfig {
  dailyRate: number;
  weeklyRate: number;
  targetTemp: number;
}

const SEASON_CONFIG: Record<number, SeasonConfig> = {
  // month (1-indexed)
  4:  { dailyRate: 150, weeklyRate: 750, targetTemp: 80 }, // April
  10: { dailyRate: 150, weeklyRate: 750, targetTemp: 80 }, // October
  5:  { dailyRate: 125, weeklyRate: 625, targetTemp: 82 }, // May
  9:  { dailyRate: 125, weeklyRate: 625, targetTemp: 82 }, // September
  6:  { dailyRate: 95,  weeklyRate: 475, targetTemp: 84 }, // June
  7:  { dailyRate: 95,  weeklyRate: 475, targetTemp: 84 }, // July
  8:  { dailyRate: 95,  weeklyRate: 475, targetTemp: 84 }, // August
};

/**
 * Get the target pool temperature for a given check-in date.
 * Falls back to 82°F for months not in the pricing table.
 */
export function getTargetTempForDate(date: Date): number {
  const month = date.getMonth() + 1;
  return SEASON_CONFIG[month]?.targetTemp ?? 82;
}

/**
 * Get pricing info for a given date.
 */
export function getPricingForDate(date: Date): SeasonConfig | null {
  const month = date.getMonth() + 1;
  return SEASON_CONFIG[month] ?? null;
}
