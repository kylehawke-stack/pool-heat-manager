/**
 * Smart heat-up time estimation using pool thermodynamics + weather forecasts.
 *
 * Physics model:
 * - Gross heating rate = (heaterBTU × efficiency) / (poolGallons × 8.34 lbs/gal)
 * - Heat loss = surfaceArea × windFactor × (waterTemp - airTemp) / (poolGallons × 8.34)
 * - Net rate = gross - loss (varies hour by hour as water temp rises and air temp changes)
 * - Simulates hour-by-hour to account for overnight cooling, dawn warming, etc.
 */

// Pool defaults (can be overridden per property later)
const POOL_DEFAULTS = {
  gallons: 20_000,
  heaterBTU: 250_000,
  heaterEfficiency: 0.82, // propane heater ~80-85% efficient
  surfaceAreaSqFt: 450,   // typical 20K gallon pool ~15x30
  waterWeightPerGallon: 8.34, // lbs
};

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
 * Calculate gross heating rate in °F/hour.
 * Formula: (BTU × efficiency) / (gallons × 8.34 lbs/gal)
 *
 * 250K BTU × 0.82 / (20,000 × 8.34) = ~1.23°F/hr gross
 */
function grossHeatingRate(
  heaterBTU: number = POOL_DEFAULTS.heaterBTU,
  efficiency: number = POOL_DEFAULTS.heaterEfficiency,
  gallons: number = POOL_DEFAULTS.gallons
): number {
  return (heaterBTU * efficiency) / (gallons * POOL_DEFAULTS.waterWeightPerGallon);
}

/**
 * Calculate heat loss rate in °F/hour for an uncovered pool.
 *
 * Dominant losses: evaporation (~60%), radiation (~20%), convection (~20%)
 * Simplified model using empirical wind-adjusted coefficient.
 *
 * Loss (BTU/hr) ≈ surfaceArea × coefficient × (waterTemp - airTemp)
 * coefficient ≈ 4 + 3.5 × windMph^0.5 (empirical, uncovered pool)
 *
 * Then convert BTU/hr loss to °F/hr: loss_BTU / (gallons × 8.34)
 */
function heatLossRate(
  waterTempF: number,
  airTempF: number,
  windMph: number,
  surfaceArea: number = POOL_DEFAULTS.surfaceAreaSqFt,
  gallons: number = POOL_DEFAULTS.gallons
): number {
  const tempDiff = waterTempF - airTempF;
  if (tempDiff <= 0) return 0; // Pool is colder than air, no net loss

  // Wind-adjusted loss coefficient (BTU/hr/sqft/°F)
  const coefficient = 4 + 3.5 * Math.sqrt(Math.max(windMph, 0));

  const lossBTUPerHour = surfaceArea * coefficient * tempDiff;
  return lossBTUPerHour / (gallons * POOL_DEFAULTS.waterWeightPerGallon);
}

/**
 * Simulate hour-by-hour pool heating to determine how many hours
 * before a target time the heater needs to turn on.
 *
 * Works backwards from the check-in time through the forecast,
 * simulating the pool temp each hour to find when to start.
 *
 * Returns: how many hours before checkIn to start, and the estimated
 * pool temp trajectory.
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

  const gross = grossHeatingRate();
  const trajectory: { hour: number; poolTemp: number; airTemp: number; netRate: number }[] = [];

  // Simulate forward from now, hour by hour
  let poolTemp = currentPoolTemp;
  let hoursNeeded = 0;

  for (let h = 0; h < forecast.length && h < 72; h++) {
    const fc = forecast[h];
    const loss = heatLossRate(poolTemp, fc.tempF, fc.windMph);
    const netRate = Math.max(gross - loss, 0.1); // Heater always makes some progress

    trajectory.push({
      hour: h,
      poolTemp: Math.round(poolTemp * 10) / 10,
      airTemp: fc.tempF,
      netRate: Math.round(netRate * 100) / 100,
    });

    poolTemp += netRate;

    if (poolTemp >= targetTemp) {
      hoursNeeded = h + 1;
      break;
    }
  }

  // If we never reached target in 72h, cap it
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
): Promise<{ startTime: Date; estimatedHours: number; avgAirTemp: number }> {
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
  const startTime = new Date(checkInTime.getTime() - totalHours * 60 * 60 * 1000);
  const now = new Date();
  const effectiveStart = startTime < now ? now : startTime;

  return {
    startTime: effectiveStart,
    estimatedHours: hoursNeeded,
    avgAirTemp,
  };
}
