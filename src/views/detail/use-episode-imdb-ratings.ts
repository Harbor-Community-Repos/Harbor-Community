import { useEffect, useMemo, useState } from "react";
import { harborImdbEpisodes, harborImdbEpisodesCached } from "@/lib/providers/harbor-imdb";
import { omdbSeasonRatings, omdbSeasonRatingsCached } from "@/lib/providers/omdb";

type RatingSources = { harbor: Map<string, number>; omdb: Map<string, number> };
function cachedRatings(imdbId: string | null, season: number): RatingSources {
  const sources: RatingSources = { harbor: new Map(), omdb: new Map() };
  if (!imdbId || !/^tt\d+$/.test(imdbId)) return sources;
  for (const [coordinate, rating] of harborImdbEpisodesCached(imdbId) ?? [])
    if (Number.isFinite(rating) && rating > 0 && rating <= 10) sources.harbor.set(coordinate, rating);
  for (const [episode, rating] of omdbSeasonRatingsCached(imdbId, season) ?? [])
    if (Number.isFinite(rating) && rating > 0 && rating <= 10) sources.omdb.set(`${season}:${episode}`, rating);
  return sources;
}

export function useEpisodeImdbRatings(imdbId: string | null, season: number, omdbKey: string) {
  const key = JSON.stringify([imdbId, season, omdbKey]);
  const cached = useMemo(() => cachedRatings(imdbId, season), [imdbId, season]);
  const [result, setResult] = useState({ key, ...cached });
  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let loading = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const publish = (source: "harbor" | "omdb", ratings: Map<string, number>) => {
      if (cancelled || ratings.size === 0) return;
      setResult((previous) => {
        const held = previous.key === key ? previous : cached;
        const merged = new Map(held[source]);
        for (const [coordinate, rating] of ratings) {
          if (Number.isFinite(rating) && rating > 0 && rating <= 10) merged.set(coordinate, rating);
        }
        return {
          key,
          harbor: source === "harbor" ? merged : held.harbor,
          omdb: source === "omdb" ? merged : held.omdb,
        };
      });
    };
    const refresh = () => {
      if (cancelled || loading || !imdbId?.match(/^tt\d+$/)) return;
      if (retry !== undefined) clearTimeout(retry);
      loading = true;
      attempts++;
      // Independent requests: a retired Harbor server must not hold up OMDb.
      const harbor = harborImdbEpisodes(imdbId)
        .then((ratings) => {
          publish("harbor", ratings);
          return ratings;
        })
        .catch(() => new Map<string, number>());
      const omdb =
        omdbKey && season >= 1
          ? omdbSeasonRatings(omdbKey, imdbId, season)
              .then((ratings) => {
                const coordinates = new Map(
                  [...ratings].map(([episode, rating]) => [`${season}:${episode}`, rating]),
                );
                publish("omdb", coordinates);
                return coordinates;
              })
              .catch(() => new Map<string, number>())
          : Promise.resolve(new Map<string, number>());
      void Promise.all([harbor, omdb]).then((sources) => {
        loading = false;
        const hasRatings = sources.some((ratings) =>
          [...ratings].some(
            ([coordinate, rating]) =>
              coordinate.startsWith(`${season}:`) &&
              Number.isFinite(rating) &&
              rating > 0 &&
              rating <= 10,
          ),
        );
        if (
          !cancelled &&
          !hasRatings &&
          ![...cached.harbor.keys(), ...cached.omdb.keys()].some((coordinate) => coordinate.startsWith(`${season}:`)) &&
          attempts < 3
        )
          retry = setTimeout(refresh, 60_000);
      });
    };
    refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("online", refresh);
      window.addEventListener("focus", refresh);
    }
    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", refresh);
        window.removeEventListener("focus", refresh);
      }
    };
  }, [key, imdbId, season, omdbKey, cached]);
  return useMemo(() => {
    const sources = result.key === key ? result : cached;
    // Preserve upstream's deterministic Harbor-first source ranking.
    return new Map([...sources.omdb, ...sources.harbor]);
  }, [result, key, cached]);
}
