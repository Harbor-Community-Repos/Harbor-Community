import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { groupEpisodes, episodeNumber, episodeSeason } from "../src/views/detail/episode-groups.ts";

const require = createRequire(import.meta.url);

test("a TMDB outage fallback keeps the season's IMDb ratings on its rows", () => {
  const CinemetaEpisodeRow = () => null;
  const { CinemetaFallback } = load("src/views/detail/series-episodes/cinemeta-fallback.tsx", {
    react: { useMemo: (fn) => fn() },
    "@/lib/i18n": { useT: () => (value) => value },
    "../cinemeta-episodes": { CinemetaEpisodeRow },
  });
  const tree = CinemetaFallback({
    meta: { id: "tt5071412" },
    season: 3,
    videos: [
      { season: 1, episode: 1 },
      { season: 3, episode: 1 },
    ],
    imdbRatings: new Map([["3:1", 8.3]]),
  });
  assert.equal(tree.props.children.length, 1);
  assert.equal(tree.props.children[0].props.imdbRating, 8.3);
});
function load(path, mocks) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)(
    (id) => mocks[id] ?? (id === "react/jsx-runtime" ? require(id) : {}),
    exports,
  );
  return exports;
}


function ratingsHarness({ harborEmpty = false, harborRequest } = {}) {
  const seasonCache = new Map();
  const slots = [],
    dependencies = [],
    effects = [];
  let cursor = 0;
  const requests = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= initial;
      return [
        slots[index],
        (value) => {
          slots[index] = typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!dependencies[index] || deps.some((value, n) => value !== dependencies[index][n])) {
        effects[index]?.();
        effects[index] = callback();
        dependencies[index] = deps;
      }
    },
    useMemo(callback, deps) {
      const index = cursor++;
      if (!dependencies[index] || deps.some((value, n) => value !== dependencies[index][n])) {
        slots[index] = callback();
        dependencies[index] = deps;
      }
      return slots[index];
    },
  };
  const { useEpisodeImdbRatings } = load("src/views/detail/use-episode-imdb-ratings.ts", {
    react,
    "@/lib/providers/harbor-imdb": {
      harborImdbEpisodes: () => harborRequest ? harborRequest() : (harborEmpty ? Promise.resolve(new Map()) : new Promise(() => {})),
      harborImdbEpisodesCached: () => undefined,
    },
    "@/lib/providers/omdb": {
      omdbSeasonRatingsCached: (id, season) => seasonCache.get(`${id}:${season}`),
      omdbSeasonRatings: (key, id, season) =>
        new Promise((resolve) =>
          requests.push({
            id,
            season,
            resolve: (ratings) => {
              seasonCache.set(`${id}:${season}`, ratings);
              resolve(ratings);
            },
          }),
        ),
    },
  });
  return {
    requests,
    unmount: () => effects.forEach((cleanup) => cleanup?.()),
    render: (id, season) => {
      cursor = 0;
      return useEpisodeImdbRatings(id, season, "test-key");
    },
  };
}

test("OMDb ratings arrive independently of an unavailable Harbor endpoint", async () => {
  const h = ratingsHarness();
  h.render("tt5071412", 3);
  h.requests[0].resolve(
    new Map([
      [1, 8.3],
      [2, 8.5],
      [3, 0],
      [4, 11],
      [5, NaN],
    ]),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    [...h.render("tt5071412", 3)],
    [
      ["3:1", 8.3],
      ["3:2", 8.5],
    ],
  );
});

test("late ratings cannot leak into another title or season", async () => {
  const h = ratingsHarness();
  h.render("tt5071412", 3);
  h.render("tt0903747", 1);
  h.requests[0].resolve(new Map([[1, 9]]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.render("tt0903747", 1).size, 0);
  h.requests[1].resolve(new Map([[1, 8.2]]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.render("tt0903747", 1).get("1:1"), 8.2);
  assert.equal(h.render("tt0903747", 2).size, 0);
});

test("Cinemeta episode grids receive genuine episode IMDb badges", () => {
  const EpisodeGrid = () => null;
  const { CinemetaEpisodes } = load("src/views/detail/cinemeta-episodes.tsx", {
    react: {
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
      useEffect: () => {},
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useSyncExternalStore: () => 0,
    },
    "@/lib/settings": {
      useSettings: () => ({
        settings: { episodeLayout: "grid", showEpisodeRating: true, omdbKey: "test-key" },
        update: () => {},
      }),
    },
    "@/lib/i18n": { useT: () => (value) => value },
    "@/lib/manual-watched": {
      manualEpisodeKeys: () => ({ watched: new Set(), unwatched: new Set() }),
    },
    "@/lib/local-library/use-series-play": { useLocalAwareSeriesPlay: () => () => {} },
    "@/lib/episode-progress": { resumeDefaultSeason: () => 3 },
    "./episode-groups": { groupEpisodes, episodeNumber, episodeSeason },
    "./helpers": { isUpcomingDate: () => false },
    "./episode-grid": { EpisodeGrid },
    "./use-episode-imdb-ratings": { useEpisodeImdbRatings: () => new Map([["3:1", 8.3]]) },
  });
  const tree = CinemetaEpisodes({
    meta: { id: "tt5071412" },
    videos: [
      { season: 1, episode: 1 },
      { season: 3, episode: 1, name: "Wartime" },
    ],
  });
  function find(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === EpisodeGrid) return node;
    for (const child of [node.props?.children].flat(Infinity)) {
      const result = find(child);
      if (result) return result;
    }
  }
  const cards = find(tree).props.episodes;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].season, 3);
  assert.equal(cards[0].rating, 8.3);
  assert.equal(cards[0].ratingIsImdb, true);
});

test("returning to a previously loaded season displays cached IMDb badges immediately", async () => {
  const h = ratingsHarness();
  h.render("tt5071412", 3);
  h.requests[0].resolve(new Map([[1, 8.3]]));
  await new Promise((resolve) => setImmediate(resolve));
  h.render("tt0903747", 1);
  assert.equal(h.render("tt5071412", 3).get("3:1"), 8.3);
});

test("missing episode badges recover automatically and cleanup cancels retry work", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalWindow = globalThis.window;
  const timers = new Map(),
    listeners = new Map();
  let next = 0;
  globalThis.setTimeout = (callback) => {
    const id = ++next;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
  const h = ratingsHarness({ harborEmpty: true });
  try {
    h.render("tt5071412", 3);
    h.requests[0].resolve(new Map());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.size, 1);
    const [id, retry] = [...timers][0];
    timers.delete(id);
    retry();
    h.requests[1].resolve(new Map([[1, 8.3]]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.render("tt5071412", 3).get("3:1"), 8.3);
    assert.equal(timers.size, 0);
    assert.ok(listeners.has("online"));
    h.unmount();
    assert.equal(listeners.size, 0);
  } finally {
    h.unmount();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});


test("Harbor ratings retain priority regardless of which provider answers first", async () => {
  for (const harborFirst of [true, false]) {
    let answerHarbor;
    const h = ratingsHarness({ harborRequest: () => new Promise(resolve => { answerHarbor = resolve; }) });
    h.render("tt5071412", 3);
    if (harborFirst) answerHarbor(new Map([["3:1", 8.7]]));
    else h.requests[0].resolve(new Map([[1, 8.3]]));
    await new Promise(resolve => setImmediate(resolve));
    if (harborFirst) h.requests[0].resolve(new Map([[1, 8.3]]));
    else answerHarbor(new Map([["3:1", 8.7]]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.render("tt5071412", 3).get("3:1"), 8.7);
    h.unmount();
  }
});
