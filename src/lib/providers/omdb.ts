import { useEffect, useState } from "react";
import { lruSet } from "../cache";
import { registerEvictable } from "../maintenance";
import { safeFetch } from "../safe-fetch";

const CACHE_MAX = 1500;
const MISS_MAX = 1000;

export type OmdbAwards = {
  oscarsWon: number;
  oscarsNominated: number;
  emmysWon: number;
  emmysNominated: number;
  baftasWon: number;
  baftasNominated: number;
  globesWon: number;
  globesNominated: number;
  totalWins: number;
  totalNominations: number;
};

export type OmdbScores = {
  imdbRating?: string;
  rated?: string;
  imdbVotes?: number;
  rtCritics?: number;
  metascore?: number;
  certifiedFresh?: boolean;
  awards?: OmdbAwards;
  fetchedAt: number;
};

export type OmdbBudget = {
  used: number;
  limit: number;
  resetAt: number;
  exhausted: boolean;
  keyInvalid: boolean;
};

const CACHE_KEY = "harbor.omdb.v1";
const BUDGET_KEY = "harbor.omdb.budget";
const MISS_KEY = "harbor.omdb.misses";
const STALE_MS = 90 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const PREFETCH_THRESHOLD = 0.9;
const CERTIFIED_FRESH_MIN_VOTES = 50000;
const DEFAULT_LIMIT = 1000;

const cache = new Map<string, OmdbScores>();
const misses = new Map<string, number>();
const inflight = new Map<string, Promise<OmdbScores | null>>();
const cacheSubs = new Map<string, Set<() => void>>();
const budgetSubs = new Set<(b: OmdbBudget) => void>();

let loaded = false;
let saveTimer: number | null = null;
let budget: OmdbBudget = { used: 0, limit: DEFAULT_LIMIT, resetAt: 0, exhausted: false, keyInvalid: false };

function nextUtcMidnight(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, OmdbScores>;
      for (const [k, v] of Object.entries(obj)) cache.set(k, v);
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(MISS_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      const now = Date.now();
      for (const [k, ts] of Object.entries(obj)) {
        if (now - ts < MISS_TTL_MS) misses.set(k, ts);
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem(BUDGET_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as OmdbBudget;
      if (parsed.resetAt && Date.now() < parsed.resetAt) {
        budget = {
          ...parsed,
          exhausted: parsed.exhausted ?? false,
          keyInvalid: parsed.keyInvalid ?? false,
        };
      } else {
        budget = freshBudget();
        persistBudget();
      }
    } else {
      budget = freshBudget();
      persistBudget();
    }
  } catch {
    budget = freshBudget();
  }
}

function freshBudget(): OmdbBudget {
  return {
    used: 0,
    limit: DEFAULT_LIMIT,
    resetAt: nextUtcMidnight(),
    exhausted: false,
    keyInvalid: false,
  };
}

function persistSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
      localStorage.setItem(MISS_KEY, JSON.stringify(Object.fromEntries(misses)));
    } catch {
      const sorted = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
      cache.clear();
      for (const [k, v] of sorted.slice(Math.floor(sorted.length / 2))) cache.set(k, v);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
      } catch {
        /* give up */
      }
    }
  }, 5000);
}

function persistBudget() {
  try {
    localStorage.setItem(BUDGET_KEY, JSON.stringify(budget));
  } catch {
    /* ignore */
  }
}

function notifyCache(imdbId: string) {
  cacheSubs.get(imdbId)?.forEach((fn) => fn());
}

function notifyBudget() {
  budgetSubs.forEach((fn) => fn(budget));
}

function rolloverIfStale() {
  if (Date.now() >= budget.resetAt) {
    budget = { ...freshBudget(), keyInvalid: budget.keyInvalid };
    persistBudget();
    notifyBudget();
  }
}

function bumpBudget() {
  rolloverIfStale();
  budget = { ...budget, used: budget.used + 1 };
  persistBudget();
  notifyBudget();
}

function markExhausted() {
  budget = { ...budget, exhausted: true, used: budget.limit, keyInvalid: false };
  persistBudget();
  notifyBudget();
}

function markKeyInvalid() {
  if (budget.keyInvalid) return;
  budget = { ...budget, keyInvalid: true };
  persistBudget();
  notifyBudget();
}

function markKeyValid() {
  if (!budget.keyInvalid && !budget.exhausted) return;
  budget = { ...budget, keyInvalid: false, exhausted: false };
  persistBudget();
  notifyBudget();
}

export function resetOmdbBudget() {
  budget = freshBudget();
  persistBudget();
  notifyBudget();
}

function parsePercent(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.match(/(\d+)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseVotes(v?: string): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseAwards(s?: string): OmdbAwards | undefined {
  if (!s || s === "N/A") return undefined;
  const lower = s.toLowerCase();
  const grab = (re: RegExp) => {
    const m = lower.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };
  const oscarsWon = grab(/won\s+(\d+)\s+oscar/);
  const oscarsNominated = grab(/nominated for\s+(\d+)\s+oscar/);
  const emmysWon = grab(/won\s+(\d+)\s+(?:primetime\s+)?emmy/);
  const emmysNominated = grab(/nominated for\s+(\d+)\s+(?:primetime\s+)?emmy/);
  const baftasWon = grab(/won\s+(\d+)\s+bafta/);
  const baftasNominated = grab(/nominated for\s+(\d+)\s+bafta/);
  const globesWon = grab(/won\s+(\d+)\s+golden globe/);
  const globesNominated = grab(/nominated for\s+(\d+)\s+golden globe/);
  const totalWins = grab(/(\d+)\s+wins?(?:\s+&|\.|\s|$)/);
  const totalNominations = grab(/(\d+)\s+nominations?/);
  const has =
    oscarsWon ||
    oscarsNominated ||
    emmysWon ||
    emmysNominated ||
    baftasWon ||
    baftasNominated ||
    globesWon ||
    globesNominated ||
    totalWins ||
    totalNominations;
  if (!has) return undefined;
  return {
    oscarsWon,
    oscarsNominated,
    emmysWon,
    emmysNominated,
    baftasWon,
    baftasNominated,
    globesWon,
    globesNominated,
    totalWins,
    totalNominations,
  };
}

export function omdbScoresCached(imdbId?: string): OmdbScores | null {
  if (!imdbId) return null;
  load();
  return cache.get(imdbId) ?? null;
}

export function omdbBudget(): OmdbBudget {
  load();
  rolloverIfStale();
  return budget;
}

export function subscribeOmdbCache(imdbId: string, fn: () => void): () => void {
  let set = cacheSubs.get(imdbId);
  if (!set) {
    set = new Set();
    cacheSubs.set(imdbId, set);
  }
  set.add(fn);
  return () => {
    const s = cacheSubs.get(imdbId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) cacheSubs.delete(imdbId);
  };
}

export function subscribeOmdbBudget(fn: (b: OmdbBudget) => void): () => void {
  budgetSubs.add(fn);
  return () => {
    budgetSubs.delete(fn);
  };
}

export function useOmdbScores(imdbId?: string): OmdbScores | null {
  const [v, setV] = useState<OmdbScores | null>(() => omdbScoresCached(imdbId));
  useEffect(() => {
    setV(omdbScoresCached(imdbId));
    if (!imdbId) return;
    return subscribeOmdbCache(imdbId, () => setV(omdbScoresCached(imdbId)));
  }, [imdbId]);
  return v;
}

export function useOmdbBudget(): OmdbBudget {
  const [b, setB] = useState<OmdbBudget>(() => omdbBudget());
  useEffect(() => {
    setB(omdbBudget());
    return subscribeOmdbBudget(setB);
  }, []);
  return b;
}

async function performFetch(key: string, imdbId: string, type?: string): Promise<OmdbScores | null> {
  try {
    let url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`;
    if (type) url += `&type=${encodeURIComponent(type)}`;
    const res = await fetch(url);
    if (res.status === 401) {
      markKeyInvalid();
      return null;
    }
    if (!res.ok) return null;
    const j = await res.json();
    if (j.Response === "False") {
      const err = String(j.Error ?? "");
      if (/invalid api key|no api key|not activated/i.test(err)) {
        markKeyInvalid();
        return null;
      }
      if (/limit|exceeded|daily|reached/i.test(err)) {
        markExhausted();
        return null;
      }
      bumpBudget();
      lruSet(misses, imdbId, Date.now(), MISS_MAX);
      persistSoon();
      return null;
    }
    bumpBudget();
    markKeyValid();
    const ratings: Array<{ Source: string; Value: string }> = j.Ratings ?? [];
    const rt = ratings.find((r) => r.Source === "Rotten Tomatoes");
    const meta = ratings.find((r) => r.Source === "Metacritic");
    const imdbVotes = parseVotes(j.imdbVotes);
    const rtCritics = parsePercent(rt?.Value);
    const scores: OmdbScores = {
      imdbRating: j.imdbRating && j.imdbRating !== "N/A" ? j.imdbRating : undefined,
      rated:
        typeof j.Rated === "string" && !/^(n\/a|not rated|unrated|nr)$/i.test(j.Rated.trim())
          ? j.Rated.trim()
          : undefined,
      imdbVotes,
      rtCritics,
      metascore: parsePercent(meta?.Value),
      certifiedFresh:
        rtCritics != null &&
        rtCritics >= 75 &&
        imdbVotes != null &&
        imdbVotes >= CERTIFIED_FRESH_MIN_VOTES,
      awards: parseAwards(j.Awards),
      fetchedAt: Date.now(),
    };
    lruSet(cache, imdbId, scores, CACHE_MAX);
    misses.delete(imdbId);
    persistSoon();
    notifyCache(imdbId);
    return scores;
  } catch {
    return null;
  }
}

function shouldServeFromCache(imdbId: string): OmdbScores | null {
  const hit = cache.get(imdbId);
  if (hit && Date.now() - hit.fetchedAt < STALE_MS) return hit;
  return null;
}

function recentMiss(imdbId: string): boolean {
  const ts = misses.get(imdbId);
  return ts != null && Date.now() - ts < MISS_TTL_MS;
}

export async function omdbScores(key: string, imdbId?: string, type?: string): Promise<OmdbScores | null> {
  if (!key || !imdbId || !imdbId.startsWith("tt")) return null;
  load();
  const fresh = shouldServeFromCache(imdbId);
  if (fresh) return fresh;
  if (inflight.has(imdbId)) return inflight.get(imdbId)!;
  rolloverIfStale();
  if (budget.exhausted || budget.keyInvalid) return null;
  const p = performFetch(key, imdbId, type).finally(() => inflight.delete(imdbId));
  inflight.set(imdbId, p);
  return p;
}

export async function omdbPrefetch(key: string, imdbId?: string, type?: string): Promise<void> {
  if (!key || !imdbId || !imdbId.startsWith("tt")) return;
  load();
  if (cache.has(imdbId) || inflight.has(imdbId) || recentMiss(imdbId)) return;
  rolloverIfStale();
  if (budget.exhausted || budget.keyInvalid) return;
  if (budget.used >= Math.floor(budget.limit * PREFETCH_THRESHOLD)) return;
  const p = performFetch(key, imdbId, type).finally(() => inflight.delete(imdbId));
  inflight.set(imdbId, p);
}

const SEASON_CACHE_KEY = "harbor.omdb.episode-ratings.v1";
const SEASON_FRESH_MS = 24 * 60 * 60_000;
const SEASON_RETRY_MS = 60_000;
const SEASON_CACHE_MAX = 200;
type SeasonRatings = { ratings: Map<number, number>; fetchedAt: number };
const seasonRatingsCache = new Map<string, SeasonRatings>();
const seasonRatingsInflight = new Map<string, Promise<Map<number, number>>>();
const seasonRetryAfter = new Map<string, number>();
let seasonsLoaded = false;

function loadSeasonRatings() {
  if (seasonsLoaded) return;
  seasonsLoaded = true;
  try {
    const stored = JSON.parse(localStorage.getItem(SEASON_CACHE_KEY) ?? "{}");
    for (const [id, entry] of Object.entries(stored)) {
      if (!/^tt\d+:\d+$/.test(id) || !entry || typeof entry !== "object") continue;
      const value = entry as { ratings?: unknown; fetchedAt?: unknown };
      if (!Array.isArray(value.ratings) || typeof value.fetchedAt !== "number") continue;
      const ratings = new Map<number, number>();
      for (const pair of value.ratings) {
        if (!Array.isArray(pair)) continue;
        const [episode, rating] = pair;
        if (
          Number.isInteger(episode) &&
          episode >= 1 &&
          Number.isFinite(rating) &&
          rating > 0 &&
          rating <= 10
        )
          ratings.set(episode, rating);
      }
      if (ratings.size)
        lruSet(seasonRatingsCache, id, { ratings, fetchedAt: value.fetchedAt }, SEASON_CACHE_MAX);
    }
  } catch {
    /* Storage failure must not prevent fresh ratings. */
  }
}

function saveSeasonRatings() {
  try {
    localStorage.setItem(
      SEASON_CACHE_KEY,
      JSON.stringify(
        Object.fromEntries(
          [...seasonRatingsCache].map(([id, entry]) => [
            id,
            { fetchedAt: entry.fetchedAt, ratings: [...entry.ratings] },
          ]),
        ),
      ),
    );
  } catch {
    /* Keep the in-memory ratings when storage is full. */
  }
}

export function omdbSeasonRatingsCached(
  imdbId?: string,
  season?: number,
): Map<number, number> | undefined {
  if (!imdbId || !season || season < 1) return undefined;
  loadSeasonRatings();
  return seasonRatingsCache.get(`${imdbId}:${season}`)?.ratings;
}

registerEvictable("omdb-season-ratings", (aggressive) => {
  if (aggressive) {
    seasonRatingsCache.clear();
    seasonsLoaded = false;
  }
});

async function performSeasonFetch(
  key: string,
  imdbId: string,
  season: number,
  cacheKey: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const fallback = () => seasonRatingsCache.get(cacheKey)?.ratings ?? out;
  try {
    const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&Season=${season}&apikey=${encodeURIComponent(key)}`;
    const res = await safeFetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status === 401) {
      markKeyInvalid();
      return fallback();
    }
    if (!res.ok) return fallback();
    const j = await res.json();
    if (j.Response === "False") {
      const err = String(j.Error ?? "");
      if (/invalid api key|no api key|not activated/i.test(err)) {
        markKeyInvalid();
        return fallback();
      }
      if (/limit|exceeded|daily|reached/i.test(err)) {
        markExhausted();
        return fallback();
      }
      bumpBudget();
      return fallback();
    }
    bumpBudget();
    markKeyValid();
    const eps: Array<{ Episode?: string; imdbRating?: string }> = j.Episodes ?? [];
    for (const e of eps) {
      const num = Number(e.Episode);
      const rating = Number(e.imdbRating);
      if (
        Number.isInteger(num) &&
        num >= 1 &&
        Number.isFinite(rating) &&
        rating > 0 &&
        rating <= 10
      )
        out.set(num, rating);
    }
    // An empty/partial provider response must never erase previously valid badges.
    if (!out.size) return fallback();
    const merged = new Map(seasonRatingsCache.get(cacheKey)?.ratings);
    for (const [episode, rating] of out) merged.set(episode, rating);
    lruSet(
      seasonRatingsCache,
      cacheKey,
      { ratings: merged, fetchedAt: Date.now() },
      SEASON_CACHE_MAX,
    );
    saveSeasonRatings();
    return merged;
  } catch {
    return fallback();
  }
}

export async function omdbSeasonRatings(
  key: string,
  imdbId?: string,
  season?: number,
): Promise<Map<number, number>> {
  const empty = new Map<number, number>();
  if (!imdbId || !/^tt\d+$/.test(imdbId) || !season || season < 1) return empty;
  load();
  loadSeasonRatings();
  const cacheKey = `${imdbId}:${season}`;
  const cached = seasonRatingsCache.get(cacheKey);
  if (!key || (cached && Date.now() - cached.fetchedAt < SEASON_FRESH_MS))
    return cached?.ratings ?? empty;
  // Credentials stay in memory; saved ratings contain only public IDs and scores.
  const requestKey = JSON.stringify([key, imdbId, season]);
  const pending = seasonRatingsInflight.get(requestKey);
  if (pending) return pending;
  rolloverIfStale();
  if (budget.exhausted || budget.keyInvalid || Date.now() < (seasonRetryAfter.get(requestKey) ?? 0))
    return cached?.ratings ?? empty;
  lruSet(seasonRetryAfter, requestKey, Date.now() + SEASON_RETRY_MS, SEASON_CACHE_MAX);
  const promise = performSeasonFetch(key, imdbId, season, cacheKey).finally(() =>
    seasonRatingsInflight.delete(requestKey),
  );
  seasonRatingsInflight.set(requestKey, promise);
  return promise;
}
