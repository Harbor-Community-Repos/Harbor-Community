import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { lruSet } from "../src/lib/cache.ts";

function fixture(store = new Map()) {
  let now = Date.now(),
    calls = 0;
  let response = async () => ({
    ok: true,
    json: async () => ({ Response: "True", Episodes: [{ Episode: "1", imdbRating: "8.3" }] }),
  });
  const evictors = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const mocks = {
    react: {},
    "../cache": { lruSet },
    "../maintenance": { registerEvictable: (name, fn) => evictors.set(name, fn) },
    "../safe-fetch": {
      safeFetch: async (_url, options) => {
        calls++;
        assert.ok(options.signal instanceof AbortSignal);
        return response();
      },
    },
  };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/lib/providers/omdb.ts", import.meta.url), "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const api = {};
  new Function("require", "exports", "localStorage", "window", "Date", code)(
    (id) => {
      assert.ok(id in mocks, id);
      return mocks[id];
    },
    api,
    storage,
    {
      setTimeout() {
        return 1;
      },
    },
    Clock,
  );
  return {
    api,
    store,
    calls: () => calls,
    advance: (ms) => {
      now += ms;
    },
    respond: (fn) => {
      response = fn;
    },
    ratings: (Episodes) => {
      response = async () => ({ ok: true, json: async () => ({ Response: "True", Episodes }) });
    },
    evict: () => evictors.get("omdb-season-ratings")(true),
  };
}
const get = (f, id = "tt5071412", season = 3) =>
  f.api.omdbSeasonRatings("premium-fixture", id, season);

test("empty episode responses back off briefly rather than poisoning the entire session", async () => {
  const f = fixture();
  f.ratings([]);
  assert.equal((await get(f)).size, 0);
  f.ratings([{ Episode: "1", imdbRating: "8.3" }]);
  assert.equal((await get(f)).size, 0);
  assert.equal(f.calls(), 1);
  f.advance(60_000);
  assert.equal((await get(f)).get(1), 8.3);
  assert.equal(f.calls(), 2);
});

test("valid episode ratings survive restart, cache eviction and provider outages", async () => {
  const f = fixture();
  await get(f);
  assert.equal(JSON.stringify([...f.store]).includes("premium-fixture"), false);
  const restarted = fixture(f.store);
  assert.equal(restarted.api.omdbSeasonRatingsCached("tt5071412", 3).get(1), 8.3);
  assert.equal((await get(restarted)).get(1), 8.3);
  assert.equal(restarted.calls(), 0);
  restarted.evict();
  assert.equal(restarted.api.omdbSeasonRatingsCached("tt5071412", 3).get(1), 8.3);
  restarted.advance(24 * 60 * 60_000);
  restarted.respond(async () => {
    throw Error("offline");
  });
  assert.equal((await get(restarted)).get(1), 8.3);
});

test("an empty or partial refresh preserves the season's previously valid badges", async () => {
  const f = fixture();
  await get(f);
  f.advance(24 * 60 * 60_000);
  f.ratings([]);
  assert.equal((await get(f)).get(1), 8.3);
  f.advance(60_000);
  f.ratings([{ Episode: "2", imdbRating: "8.5" }]);
  assert.deepEqual(
    [...(await get(f))],
    [
      [1, 8.3],
      [2, 8.5],
    ],
  );
});

test("episode cache isolates titles/seasons and validates provider ratings", async () => {
  const f = fixture();
  f.ratings([
    { Episode: "1", imdbRating: "8.3" },
    { Episode: "2", imdbRating: "N/A" },
    { Episode: "3", imdbRating: "11" },
    { Episode: "4", imdbRating: "8garbage" },
    { Episode: "0", imdbRating: "9" },
  ]);
  assert.deepEqual([...(await get(f))], [[1, 8.3]]);
  assert.equal(f.api.omdbSeasonRatingsCached("tt5071412", 2), undefined);
  assert.equal(f.api.omdbSeasonRatingsCached("tt0903747", 3), undefined);
});

test("a stalled/aborted request is released so a later attempt can recover", async () => {
  const f = fixture();
  f.respond(async () => {
    throw new DOMException("timeout", "TimeoutError");
  });
  assert.equal((await get(f)).size, 0);
  f.advance(60_000);
  f.ratings([{ Episode: "1", imdbRating: "8.3" }]);
  assert.equal((await get(f)).get(1), 8.3);
});

test("provider-confirmed quota failures still prevent additional requests while retaining cached badges", async () => {
  const f = fixture();
  await get(f);
  f.advance(24 * 60 * 60_000);
  f.respond(async () => ({
    ok: true,
    json: async () => ({ Response: "False", Error: "Request limit reached" }),
  }));
  assert.equal((await get(f)).get(1), 8.3);
  f.advance(60_000);
  assert.equal((await get(f)).get(1), 8.3);
  assert.equal(f.calls(), 2);
});
