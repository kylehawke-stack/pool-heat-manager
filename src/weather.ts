/**
 * Smart heat-up time estimation using empirical heating rates + weather forecasts.
 *
 * Based on real-world observation: ~1°F/hr net heating rate for a 250K BTU
 * propane heater on a ~20K gallon uncovered pool, with reduced rates during
 * cold overnight temps when heat loss is higher.
 */

interface HourlyForecast {
  time: string[];
  temperature_2m: number[];
  wind_speed_10m: number[];
}

interface ForecastResponse {
  hourly: HourlyForecast;
}

export interface ForecastPoint {
  time: Date;
  tempF: number;
  windMph: number;
}

/**
 * Empirical net heating rate based on air temperature.
 * ~1°F/hr in normal conditions, reduced in cold overnight temps.
 */
function netHeatingRate(airTempF: number): number {
  if (airTempF >= 50) return 1.0;
  if (airTempF >= 35) return 0.75;
  return 0.5;
}

export async function getHourlyForecast(
  latitude: number,
  longitude: number,
  hours: number = 72
): Promise<ForecastPoint[]> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_hours=${hours}&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo API failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as ForecastResponse;
  return data.hourly.time.map((t, i) => ({
    time: new Date(t),
    tempF: data.hourly.temperature_2m[i],
    windMph: data.hourly.wind_speed_10m[i] ?? 5,
  }));
}

/**
 * Simulate hour-by-hour pool heating using empirical rates + weather forecast.
 *
 * Returns: how many hours of heating needed and the hourly trajectory.
 */
export function simulateHeatUp(
  currentPoolTemp: number,
  targetTemp: number,
  forecast: ForecastPoint[],
  checkInTime: Date,
): { hoursNeeded: number; trajectory: { hour: number; poolTemp: number; airTemp: number; netRate: number }[] } {
  if (currentPoolTemp >= targetTemp) {
    return { hoursNeeded: 0, trajectory: [] };
  }

  const trajectory: { hour: number; poolTemp: number; airTemp: number; netRate: number }[] = [];
  let poolTemp = currentPoolTemp;
  let hoursNeeded = 0;

  for (let h = 0; h < forecast.length && h < 72; h++) {
    const fc = forecast[h];
    const rate = netHeatingRate(fc.tempF);

    trajectory.push({
      hour: h,
      poolTemp: Math.round(poolTemp * 10) / 10,
      airTemp: fc.tempF,
      netRate: rate,
    });

    poolTemp += rate;

    if (poolTemp >= targetTemp) {
      hoursNeeded = h + 1;
      break;
    }
  }

  if (poolTemp < targetTemp) {
    hoursNeeded = 72;
  }

  return { hoursNeeded, trajectory };
}

/**
 * Given a check-in time, calculate when to turn the heater on.
 * Uses real pool temp (from ScreenLogic) + hourly weather forecast
 * to simulate hour-by-hour heating and find the optimal start time.
 *
 * Adds a 2-hour buffer for safety.
 */
export async function calculateHeaterStartTime(
  checkInTime: Date,
  targetTemp: number,
  currentPoolTemp: number | null,
  latitude: number,
  longitude: number
): Promise<{
  startTime: Date;
  estimatedHours: number;
  avgAirTemp: number;
  clamped: boolean;
  shortfallHours: number;
}> {
  const forecast = await getHourlyForecast(latitude, longitude, 72);

  // If we don't know pool temp, estimate from recent air temps
  const poolTemp = currentPoolTemp ?? (forecast.length > 0 ? forecast[0].tempF + 2 : 60);

  const { hoursNeeded, trajectory } = simulateHeatUp(poolTemp, targetTemp, forecast, checkInTime);

  // Average air temp over the heating period
  const relevantTemps = forecast.slice(0, hoursNeeded || 24).map(f => f.tempF);
  const avgAirTemp = relevantTemps.length > 0
    ? relevantTemps.reduce((a, b) => a + b, 0) / relevantTemps.length
    : 60;

  // Add 2 hour buffer, and ensure we don't start in the past
  const totalHours = hoursNeeded + 2;
  const idealStart = new Date(checkInTime.getTime() - totalHours * 60 * 60 * 1000);
  const now = new Date();
  const clamped = idealStart < now;
  const effectiveStart = clamped ? now : idealStart;

  // If clamped, how many hours of heat-up we're losing vs. the ideal schedule.
  const shortfallHours = clamped
    ? Math.max(0, (now.getTime() - idealStart.getTime()) / (1000 * 60 * 60))
    : 0;

  return {
    startTime: effectiveStart,
    estimatedHours: hoursNeeded,
    avgAirTemp,
    clamped,
    shortfallHours,
  };
}
