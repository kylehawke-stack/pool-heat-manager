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
  3:  { dailyRate: 150, weeklyRate: 750, targetTemp: 80 }, // March (same as April — shoulder)
  4:  { dailyRate: 150, weeklyRate: 750, targetTemp: 80 }, // April
  10: { dailyRate: 150, weeklyRate: 750, targetTemp: 80 }, // October
  11: { dailyRate: 150, weeklyRate: 750, targetTemp: 80 }, // November (same as October — shoulder)
  5:  { dailyRate: 125, weeklyRate: 625, targetTemp: 82 }, // May
  9:  { dailyRate: 125, weeklyRate: 625, targetTemp: 82 }, // September
  6:  { dailyRate: 95,  weeklyRate: 475, targetTemp: 84 }, // June
  7:  { dailyRate: 95,  weeklyRate: 475, targetTemp: 84 }, // July
  8:  { dailyRate: 95,  weeklyRate: 475, targetTemp: 84 }, // August
};

/**
 * Get the target pool temperature for a stay.
 *
 * Uses the month where the majority of the stay falls. For cross-month stays
 * (e.g. March 31 → April 6), the month with more nights wins.
 * This ensures a March 31 check-in for an April stay uses April's 80°F target.
 */
export function getTargetTempForStay(arrivalDate: string, departureDate: string): number {
  const arrival = new Date(arrivalDate + 'T12:00:00');
  const departure = new Date(departureDate + 'T12:00:00');

  // Count nights per month
  const monthNights: Record<number, number> = {};
  const cursor = new Date(arrival);
  while (cursor < departure) {
    const month = cursor.getMonth() + 1;
    monthNights[month] = (monthNights[month] || 0) + 1;
    cursor.setDate(cursor.getDate() + 1);
  }

  // Find the month with the most nights
  let bestMonth = arrival.getMonth() + 1;
  let bestCount = 0;
  for (const [month, count] of Object.entries(monthNights)) {
    if (count > bestCount) {
      bestCount = count;
      bestMonth = Number(month);
    }
  }

  return SEASON_CONFIG[bestMonth]?.targetTemp ?? 80;
}

/**
 * Simple version: get target temp for a single date.
 */
export function getTargetTempForDate(date: Date): number {
  const month = date.getMonth() + 1;
  return SEASON_CONFIG[month]?.targetTemp ?? 80;
}

/**
 * Get pricing info for a given date.
 */
export function getPricingForDate(date: Date): SeasonConfig | null {
  const month = date.getMonth() + 1;
  return SEASON_CONFIG[month] ?? null;
}
