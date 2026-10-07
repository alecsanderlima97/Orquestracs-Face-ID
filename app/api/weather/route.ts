import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 900;

function weatherKind(code: number) {
  if (code >= 95) return "storm";
  if (code >= 51 && code <= 86) return "rain";
  if (code >= 45 && code <= 48) return "cloudy";
  if (code >= 1 && code <= 3) return "cloudy";
  return "clear";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const city = url.searchParams.get("city")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const latitudeParam = url.searchParams.get("latitude");
  const longitudeParam = url.searchParams.get("longitude");
  const requestedLatitude = latitudeParam ? Number(latitudeParam) : Number.NaN;
  const requestedLongitude = longitudeParam ? Number(longitudeParam) : Number.NaN;
  const hasCoordinates = Number.isFinite(requestedLatitude)
    && Number.isFinite(requestedLongitude)
    && Math.abs(requestedLatitude) <= 90
    && Math.abs(requestedLongitude) <= 180;

  if (!city && !hasCoordinates) {
    return NextResponse.json({ available: false, reason: "missing-city" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    let location: { admin1?: string; country?: string; latitude: number; longitude: number; name: string } | undefined;
    if (hasCoordinates) {
      location = {
        admin1: state || "",
        country: "Brasil",
        latitude: requestedLatitude,
        longitude: requestedLongitude,
        name: city || "Localização atual",
      };
    } else {
      const locationQuery = [city, state].filter(Boolean).join(", ");
      const geocodingUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
      geocodingUrl.searchParams.set("name", locationQuery);
      geocodingUrl.searchParams.set("count", "1");
      geocodingUrl.searchParams.set("language", "pt");
      geocodingUrl.searchParams.set("format", "json");

      const geocodingResponse = await fetch(geocodingUrl, {
        signal: controller.signal,
        next: { revalidate: 3600 },
      });
      if (!geocodingResponse.ok) throw new Error("geocoding-failed");

      const geocodingData = (await geocodingResponse.json()) as {
        results?: Array<{ admin1?: string; country?: string; latitude: number; longitude: number; name: string }>;
      };
      location = geocodingData.results?.[0];
      if (!location) {
        return NextResponse.json({ available: false, reason: "city-not-found" });
      }
    }

    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.searchParams.set("latitude", String(location.latitude));
    forecastUrl.searchParams.set("longitude", String(location.longitude));
    forecastUrl.searchParams.set("current", "temperature_2m,weather_code,is_day");
    forecastUrl.searchParams.set("timezone", "America/Sao_Paulo");

    const forecastResponse = await fetch(forecastUrl, {
      signal: controller.signal,
      next: { revalidate: 900 },
    });
    if (!forecastResponse.ok) throw new Error("forecast-failed");

    const forecastData = (await forecastResponse.json()) as {
      current?: { is_day?: number; temperature_2m?: number; weather_code?: number };
    };
    const current = forecastData.current;
    if (!current || typeof current.weather_code !== "number") {
      return NextResponse.json({ available: false, reason: "current-weather-unavailable" });
    }

    return NextResponse.json({
      available: true,
      city: location.name,
      country: location.country || "",
      isDay: current.is_day !== 0,
      kind: weatherKind(current.weather_code),
      source: hasCoordinates ? "current" : "company",
      state: location.admin1 || state || "",
      temperature: typeof current.temperature_2m === "number" ? current.temperature_2m : null,
      weatherCode: current.weather_code,
    });
  } catch (error) {
    console.error("Weather lookup failed", error);
    return NextResponse.json({ available: false, reason: "weather-unavailable" });
  } finally {
    clearTimeout(timeout);
  }
}
