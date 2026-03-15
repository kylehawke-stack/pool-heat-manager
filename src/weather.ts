/**
 * Open-Meteo weather API for smart heat-up time estimation.
 * Free, no API key needed.
 */

interface HourlyForecast {
  time: string[];
  temperature_2m: number[];
}

interface ForecastResponse {
  hourly: HourlyForecast;
}

export async function getHourlyForecast(
  latitude: number,
  longitude: number,
  hours: number = 48
): Promise<{ time: Date; tempF: number }[]> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=temperature_2m&temperature_unit=fahrenheit&forecast_hours=${hours}&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo API failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as ForecastResponse;
  return data.hourly.time.map((t, i) => ({
    time: new Date(t),
    tempF: data.hourly.temperature_2m[i],
  }));
}

/**
 * Estimate how many hours it will take to heat the pool to target temp.
 *
 * Factors:
 * - Current pool temp (from ScreenLogic or estimated from recent air temps)
 * - Target temp
 * - Average air temp during heating period (affects heat loss)
 *
 * Rule of thumb for gas heaters on ~20,000 gallon pools:
 * - Heater raises water ~1-2°F per hour in warm weather (air > 70°F)
 * - Heater raises water ~0.5-1°F per hour in cold weather (air < 60°F)
 * - Heat loss increases as water-air temp differential grows
 */
export function estimateHeatUpHours(
  currentPoolTemp: number | null,
  targetTemp: number,
  avgAirTemp: number
): number {
  // If we don't know pool temp, estimate it as slightly above recent avg air temp
  const poolTemp = currentPoolTemp ?? (avgAirTemp + 2);
  const tempDelta = targetTemp - poolTemp;

  if (tempDelta <= 0) return 0; // Already at or above target

  // Heating rate depends on air temperature (affects heat loss)
  let degreesPerHour: number;
  if (avgAirTemp >= 75) {
    degreesPerHour = 1.5;
  } else if (avgAirTemp >= 65) {
    degreesPerHour = 1.2;
  } else if (avgAirTemp >= 55) {
    degreesPerHour = 0.8;
  } else {
    degreesPerHour = 0.5;
  }

  const hours = Math.ceil(tempDelta / degreesPerHour);

  // Cap at 48 hours (if it's going to take longer, something is wrong)
  return Math.min(hours, 48);
}

/**
 * Given a check-in time, calculate when to turn the heater on.
 * Returns the recommended start time and estimated hours to heat.
 */
export async function calculateHeaterStartTime(
  checkInTime: Date,
  targetTemp: number,
  currentPoolTemp: number | null,
  latitude: number,
  longitude: number
): Promise<{ startTime: Date; estimatedHours: number; avgAirTemp: number }> {
  const forecast = await getHourlyForecast(latitude, longitude, 48);

  // Average air temp over the next 24-48 hours
  const relevantTemps = forecast
    .filter(f => f.time <= checkInTime)
    .map(f => f.tempF);

  const avgAirTemp = relevantTemps.length > 0
    ? relevantTemps.reduce((a, b) => a + b, 0) / relevantTemps.length
    : 70; // fallback

  const estimatedHours = estimateHeatUpHours(currentPoolTemp, targetTemp, avgAirTemp);

  // Add 2 hours buffer
  const startTime = new Date(checkInTime.getTime() - (estimatedHours + 2) * 60 * 60 * 1000);

  return { startTime, estimatedHours, avgAirTemp };
}
