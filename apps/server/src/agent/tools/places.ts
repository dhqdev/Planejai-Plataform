import { getCredentials } from "../../integrations/registry.js";
import { mapsUrl } from "./research.js";
import { defineTool, obj } from "./types.js";

/**
 * Lugares perto de um endereço, sem abrir navegador: Google Places (com a chave do Google Maps)
 * ou, sem chave, o OpenStreetMap (Nominatim), que é grátis. Uma ou duas chamadas HTTP, segundos em vez de minutos.
 */

export interface Place {
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  distance_km: number;
  phone: string | null;
  open_now?: boolean;
  rating?: number;
  maps: string;
}

interface Point {
  lat: number;
  lng: number;
  label: string;
}

const UA = "Planejai/1.0 (assistente pessoal; contato pelo painel)";

/** Distância em linha reta (km), com 1 casa. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/** Palavras do dia a dia que o OpenStreetMap entende melhor em inglês (shop=pet etc.). */
const OSM_TERMS: [RegExp, string][] = [
  [/pet ?shop|petshop|banho e tosa|ra[cç][aã]o/i, "pet shop"],
  [/veterin/i, "veterinary"],
  [/farm[aá]cia|drogaria/i, "pharmacy"],
  [/padaria/i, "bakery"],
  [/supermercado|mercado/i, "supermarket"],
  [/posto( de gasolina)?|combust/i, "fuel"],
  [/academia/i, "gym"],
  [/hospital|pronto.?socorro/i, "hospital"],
  [/restaurante/i, "restaurant"],
  [/lanchonete|hamburgu/i, "fast food"],
  [/barbearia|sal[aã]o|cabeleireir/i, "hairdresser"],
  [/caixa eletr[oô]nico/i, "atm"],
  [/banco\b/i, "bank"],
  [/oficina|mec[aâ]nic/i, "car repair"],
  [/lavanderia/i, "laundry"],
];

// Nominatim pede no máximo 1 chamada por segundo
let nominatimAt = 0;
async function nominatim(params: Record<string, string>): Promise<any[]> {
  const wait = nominatimAt + 1100 - Date.now();
  nominatimAt = Date.now() + Math.max(0, wait);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "jsonv2", "accept-language": "pt-BR", countrycodes: "br", ...params })}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`OpenStreetMap ${res.status}`);
  return (await res.json()) as any[];
}

async function googleSearch(key: string, body: Record<string, unknown>, fields: string): Promise<any[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields },
    body: JSON.stringify({ languageCode: "pt-BR", regionCode: "BR", ...body }),
    signal: AbortSignal.timeout(12_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Maps ${res.status}: ${String(j?.error?.message ?? "").slice(0, 160)}`);
  return j.places ?? [];
}

/** Endereço -> coordenadas. */
export async function geocode(address: string): Promise<Point | null> {
  const g = await getCredentials("google_maps");
  if (g?.api_key) {
    const [p] = await googleSearch(g.api_key, { textQuery: address, maxResultCount: 1 }, "places.location,places.formattedAddress");
    if (p?.location) return { lat: p.location.latitude, lng: p.location.longitude, label: p.formattedAddress ?? address };
  }
  const [r] = await nominatim({ q: address, limit: "1" });
  return r ? { lat: Number(r.lat), lng: Number(r.lon), label: r.display_name } : null;
}

const GOOGLE_FIELDS =
  "places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber,places.currentOpeningHours.openNow,places.rating";

async function searchGoogle(key: string, what: string, at: Point, radiusKm: number): Promise<Place[]> {
  const places = await googleSearch(
    key,
    {
      textQuery: what,
      maxResultCount: 10,
      locationBias: { circle: { center: { latitude: at.lat, longitude: at.lng }, radius: Math.min(radiusKm, 50) * 1000 } },
      rankPreference: "DISTANCE",
    },
    GOOGLE_FIELDS,
  );
  return places
    .filter((p) => p.location)
    .map((p) => {
      const name = p.displayName?.text ?? what;
      return {
        name,
        address: p.formattedAddress ?? null,
        lat: p.location.latitude,
        lng: p.location.longitude,
        distance_km: distanceKm(at, { lat: p.location.latitude, lng: p.location.longitude }),
        phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
        open_now: p.currentOpeningHours?.openNow,
        rating: p.rating,
        maps: mapsUrl(`${name}, ${p.formattedAddress ?? ""}`),
      };
    });
}

function osmAddress(r: any): string | null {
  const a = r.address ?? {};
  const street = [a.road, a.house_number].filter(Boolean).join(", ");
  const parts = [street, a.suburb ?? a.neighbourhood, a.city ?? a.town ?? a.village].filter(Boolean);
  return parts.length ? parts.join(", ") : (r.display_name ?? null);
}

async function searchOsm(what: string, at: Point, radiusKm: number): Promise<Place[]> {
  const term = OSM_TERMS.find(([re]) => re.test(what))?.[1];
  const queries = [...new Set([term, what].filter(Boolean) as string[])];
  const found = new Map<string, Place>();
  // primeiro perto (~3 km), depois mais longe se não achar nada
  for (const km of [Math.min(3, radiusKm), radiusKm]) {
    const d = km / 111;
    const box = [at.lng - d, at.lat + d, at.lng + d, at.lat - d].map((n) => n.toFixed(5)).join(",");
    for (const q of queries) {
      const rows = await nominatim({ q, limit: "20", viewbox: box, bounded: "1", addressdetails: "1", extratags: "1" }).catch(() => []);
      for (const r of rows) {
        const lat = Number(r.lat);
        const lng = Number(r.lon);
        const name = r.name || r.display_name?.split(",")[0] || what;
        const key = `${name}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
        if (found.has(key)) continue;
        const address = osmAddress(r);
        found.set(key, {
          name,
          address,
          lat,
          lng,
          distance_km: distanceKm(at, { lat, lng }),
          phone: r.extratags?.phone ?? r.extratags?.["contact:phone"] ?? r.extratags?.["contact:whatsapp"] ?? null,
          maps: mapsUrl(`${name}, ${address ?? ""}`),
        });
      }
    }
    if (found.size) break;
  }
  return [...found.values()];
}

/** Os lugares mais perto primeiro. */
export async function nearbyPlaces(what: string, near: string, opts: { limit?: number; radiusKm?: number } = {}) {
  const at = await geocode(near);
  if (!at) return { error: `Não achei o endereço "${near}" no mapa. Peça o bairro e a cidade.` };
  const radius = Math.min(Math.max(opts.radiusKm ?? 10, 1), 50);
  const g = await getCredentials("google_maps");
  let source = g?.api_key ? "google" : "openstreetmap";
  let list: Place[] = [];
  if (g?.api_key) {
    try {
      list = await searchGoogle(g.api_key, what, at, radius);
    } catch {
      source = "openstreetmap";
    }
  }
  if (!list.length) list = await searchOsm(what, at, radius);
  list = list.filter((p) => p.distance_km <= radius).sort((a, b) => a.distance_km - b.distance_km);
  const limit = Math.min(Math.max(opts.limit ?? 1, 1), 5);
  return { source, from: at.label, total_found: list.length, places: list.slice(0, limit) };
}

export const placesNearby = defineTool<{ what: string; near: string; limit?: number; radius_km?: number }>({
  name: "places_nearby",
  description:
    "Acha lugares perto de um endereço (petshop, farmácia, mercado, restaurante...) em segundos, sem navegador: nome, endereço, distância, telefone e link do Maps, do mais perto ao mais longe. " +
    "Use para 'qual X mais perto', 'tem Y aqui perto'. limit: quantos devolver (padrão 1; só mais se a pessoa pedir opções).",
  parameters: obj(
    {
      what: { type: "string", description: "O que procurar, ex.: 'petshop', 'farmácia 24h'" },
      near: { type: "string", description: "Endereço de referência (rua e número, bairro, cidade), da memória ou da localização que a pessoa mandou" },
      limit: { type: "number", description: "1 a 5, padrão 1" },
      radius_km: { type: "number", description: "Raio máximo, padrão 10" },
    },
    ["what", "near"],
  ),
  async run(args) {
    return nearbyPlaces(args.what, args.near, { limit: args.limit, radiusKm: args.radius_km });
  },
});
