type WeatherDecision = 'GO' | 'CAUTION' | 'NO_GO';

export interface WeatherRiskThresholds {
  maxWindSpeedMps: number;
  maxGustSpeedMps: number;
  maxPrecipProbability: number;
  minTemperatureC: number;
  maxTemperatureC: number;
}

export interface HourlyWeatherPoint {
  timestamp: string;
  windSpeedMps: number;
  windGustMps: number;
  precipitationProbability: number;
  temperatureC: number;
}

export interface WeatherForecastSnapshot {
  provider: 'open-meteo';
  fetchedAt: string;
  latitude: number;
  longitude: number;
  timezone: string;
  points: HourlyWeatherPoint[];
}

export interface WeatherRiskAssessment {
  score: number;
  decision: WeatherDecision;
  reasons: string[];
}

export interface WeatherWindowAssessment extends WeatherRiskAssessment {
  sampleCount: number;
  avgWindSpeedMps: number;
  maxWindSpeedMps: number;
  avgWindGustMps: number;
  maxWindGustMps: number;
  avgPrecipProbability: number;
  maxPrecipProbability: number;
  avgTemperatureC: number;
  minTemperatureC: number;
  maxTemperatureC: number;
}

interface OpenMeteoHourlyResponse {
  time?: unknown;
  wind_speed_10m?: unknown;
  wind_gusts_10m?: unknown;
  precipitation_probability?: unknown;
  temperature_2m?: unknown;
}

interface OpenMeteoResponse {
  timezone?: unknown;
  hourly?: OpenMeteoHourlyResponse;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeDate(value: string): string | null {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function getDecisionSeverity(decision: WeatherDecision): number {
  if (decision === 'NO_GO') return 2;
  if (decision === 'CAUTION') return 1;
  return 0;
}

function mergeDecision(a: WeatherDecision, b: WeatherDecision): WeatherDecision {
  return getDecisionSeverity(b) > getDecisionSeverity(a) ? b : a;
}

export function assessWeatherPoint(
  point: HourlyWeatherPoint,
  thresholds: WeatherRiskThresholds
): WeatherRiskAssessment {
  const windRatio = thresholds.maxWindSpeedMps > 0 ? point.windSpeedMps / thresholds.maxWindSpeedMps : 0;
  const gustRatio = thresholds.maxGustSpeedMps > 0 ? point.windGustMps / thresholds.maxGustSpeedMps : 0;
  const precipRatio = thresholds.maxPrecipProbability > 0
    ? point.precipitationProbability / thresholds.maxPrecipProbability
    : 0;

  let tempRisk = 0;
  if (point.temperatureC < thresholds.minTemperatureC) {
    tempRisk = clamp((thresholds.minTemperatureC - point.temperatureC) / 8, 0, 1.5);
  } else if (point.temperatureC > thresholds.maxTemperatureC) {
    tempRisk = clamp((point.temperatureC - thresholds.maxTemperatureC) / 8, 0, 1.5);
  }

  const score = clamp(
    windRatio * 0.35 + gustRatio * 0.35 + precipRatio * 0.2 + tempRisk * 0.1,
    0,
    1.5
  );

  const reasons: string[] = [];
  if (point.windSpeedMps > thresholds.maxWindSpeedMps) {
    reasons.push(`Wind ${point.windSpeedMps.toFixed(1)} m/s exceeds limit ${thresholds.maxWindSpeedMps.toFixed(1)} m/s`);
  } else if (point.windSpeedMps > thresholds.maxWindSpeedMps * 0.8) {
    reasons.push(`Wind near limit (${point.windSpeedMps.toFixed(1)} m/s)`);
  }

  if (point.windGustMps > thresholds.maxGustSpeedMps) {
    reasons.push(`Gusts ${point.windGustMps.toFixed(1)} m/s exceed limit ${thresholds.maxGustSpeedMps.toFixed(1)} m/s`);
  } else if (point.windGustMps > thresholds.maxGustSpeedMps * 0.8) {
    reasons.push(`Gusts near limit (${point.windGustMps.toFixed(1)} m/s)`);
  }

  if (point.precipitationProbability > thresholds.maxPrecipProbability) {
    reasons.push(`Precipitation probability ${point.precipitationProbability.toFixed(0)}% exceeds limit ${thresholds.maxPrecipProbability.toFixed(0)}%`);
  } else if (point.precipitationProbability > thresholds.maxPrecipProbability * 0.75) {
    reasons.push(`Elevated precipitation risk (${point.precipitationProbability.toFixed(0)}%)`);
  }

  if (point.temperatureC < thresholds.minTemperatureC) {
    reasons.push(`Temperature ${point.temperatureC.toFixed(1)}°C is below minimum ${thresholds.minTemperatureC.toFixed(1)}°C`);
  } else if (point.temperatureC > thresholds.maxTemperatureC) {
    reasons.push(`Temperature ${point.temperatureC.toFixed(1)}°C is above maximum ${thresholds.maxTemperatureC.toFixed(1)}°C`);
  }

  let decision: WeatherDecision = 'GO';
  const hardNoGo =
    point.windSpeedMps > thresholds.maxWindSpeedMps * 1.1 ||
    point.windGustMps > thresholds.maxGustSpeedMps * 1.1 ||
    point.precipitationProbability > thresholds.maxPrecipProbability + 20 ||
    point.temperatureC < thresholds.minTemperatureC - 2 ||
    point.temperatureC > thresholds.maxTemperatureC + 2;

  if (hardNoGo || score >= 1.0) {
    decision = 'NO_GO';
  } else if (
    score >= 0.75 ||
    point.windSpeedMps > thresholds.maxWindSpeedMps ||
    point.windGustMps > thresholds.maxGustSpeedMps ||
    point.precipitationProbability > thresholds.maxPrecipProbability
  ) {
    decision = 'CAUTION';
  }

  return {
    score: clamp(score, 0, 1),
    decision,
    reasons,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function assessWeatherWindow(
  points: HourlyWeatherPoint[],
  thresholds: WeatherRiskThresholds
): WeatherWindowAssessment {
  if (points.length === 0) {
    return {
      score: 1,
      decision: 'NO_GO',
      reasons: ['No forecast data available for mission window'],
      sampleCount: 0,
      avgWindSpeedMps: 0,
      maxWindSpeedMps: 0,
      avgWindGustMps: 0,
      maxWindGustMps: 0,
      avgPrecipProbability: 0,
      maxPrecipProbability: 0,
      avgTemperatureC: 0,
      minTemperatureC: 0,
      maxTemperatureC: 0,
    };
  }

  const assessments = points.map((point) => assessWeatherPoint(point, thresholds));
  const combinedReasons = Array.from(new Set(assessments.flatMap((assessment) => assessment.reasons))).slice(0, 6);
  const maxScore = Math.max(...assessments.map((assessment) => assessment.score));
  const avgScore = average(assessments.map((assessment) => assessment.score));
  const score = clamp(maxScore * 0.7 + avgScore * 0.3, 0, 1);

  const decision = assessments.reduce<WeatherDecision>(
    (current, assessment) => mergeDecision(current, assessment.decision),
    'GO'
  );

  const winds = points.map((point) => point.windSpeedMps);
  const gusts = points.map((point) => point.windGustMps);
  const precip = points.map((point) => point.precipitationProbability);
  const temps = points.map((point) => point.temperatureC);

  return {
    score,
    decision,
    reasons: combinedReasons,
    sampleCount: points.length,
    avgWindSpeedMps: average(winds),
    maxWindSpeedMps: Math.max(...winds),
    avgWindGustMps: average(gusts),
    maxWindGustMps: Math.max(...gusts),
    avgPrecipProbability: average(precip),
    maxPrecipProbability: Math.max(...precip),
    avgTemperatureC: average(temps),
    minTemperatureC: Math.min(...temps),
    maxTemperatureC: Math.max(...temps),
  };
}

function closestPoint(points: HourlyWeatherPoint[], timestampMs: number): HourlyWeatherPoint | null {
  if (points.length === 0) return null;

  let best = points[0];
  let bestDelta = Math.abs(new Date(best.timestamp).getTime() - timestampMs);

  for (let i = 1; i < points.length; i += 1) {
    const candidate = points[i];
    const delta = Math.abs(new Date(candidate.timestamp).getTime() - timestampMs);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }

  return best;
}

export function pickForecastPointsForWindow(
  forecast: WeatherForecastSnapshot,
  startMs: number,
  endMs: number
): HourlyWeatherPoint[] {
  const matches = forecast.points.filter((point) => {
    const timestamp = new Date(point.timestamp).getTime();
    return timestamp >= startMs && timestamp <= endMs;
  });

  if (matches.length > 0) return matches;
  const fallback = closestPoint(forecast.points, startMs);
  return fallback ? [fallback] : [];
}

export async function fetchWeatherForecast(
  latitude: number,
  longitude: number,
  lookaheadHours: number
): Promise<WeatherForecastSnapshot> {
  const safeLookahead = Math.max(6, Math.min(72, Math.floor(lookaheadHours)));
  const forecastDays = Math.max(1, Math.ceil(safeLookahead / 24) + 1);

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', latitude.toFixed(6));
  url.searchParams.set('longitude', longitude.toFixed(6));
  url.searchParams.set('hourly', 'wind_speed_10m,wind_gusts_10m,precipitation_probability,temperature_2m');
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('forecast_days', String(forecastDays));

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AgriDrone-Ops-Weather/1.0',
    },
    signal: AbortSignal.timeout(9000),
  });

  if (!response.ok) {
    throw new Error(`Weather provider returned ${response.status}`);
  }

  const payload = (await response.json()) as OpenMeteoResponse;
  const timezone = typeof payload.timezone === 'string' ? payload.timezone : 'UTC';
  const hourly = payload.hourly;

  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  const windSpeeds = Array.isArray(hourly?.wind_speed_10m) ? hourly.wind_speed_10m : [];
  const windGusts = Array.isArray(hourly?.wind_gusts_10m) ? hourly.wind_gusts_10m : [];
  const precipProb = Array.isArray(hourly?.precipitation_probability) ? hourly.precipitation_probability : [];
  const temperatures = Array.isArray(hourly?.temperature_2m) ? hourly.temperature_2m : [];

  const now = Date.now();
  const end = now + safeLookahead * 60 * 60 * 1000;

  const points: HourlyWeatherPoint[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const rawTime = typeof times[i] === 'string' ? times[i] : null;
    if (!rawTime) continue;

    const timestamp = normalizeDate(rawTime);
    if (!timestamp) continue;

    const timeMs = new Date(timestamp).getTime();
    if (timeMs < now - 60 * 60 * 1000) continue;
    if (timeMs > end) continue;

    points.push({
      timestamp,
      windSpeedMps: clamp(toFiniteNumber(windSpeeds[i], 0), 0, 60),
      windGustMps: clamp(toFiniteNumber(windGusts[i], 0), 0, 80),
      precipitationProbability: clamp(toFiniteNumber(precipProb[i], 0), 0, 100),
      temperatureC: clamp(toFiniteNumber(temperatures[i], 0), -50, 70),
    });
  }

  if (points.length === 0) {
    throw new Error('Weather provider returned no usable hourly forecast data');
  }

  return {
    provider: 'open-meteo',
    fetchedAt: new Date().toISOString(),
    latitude,
    longitude,
    timezone,
    points,
  };
}
