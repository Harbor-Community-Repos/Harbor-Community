// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { cwDismissGroup } from "../src/lib/cw-dismiss-group";
import type { LibraryItem } from "../src/lib/stremio";

test("dismissal includes alternate IDs and tracker copies hidden beneath a card", () => {
  const visible: LibraryItem = { _id: "tt1", type: "movie", name: "Film", removed: false };
  const copies: LibraryItem[] = [
    { ...visible, external: "trakt" },
    { ...visible, _id: "tmdb:movie:1", name: "FILM" },
    { ...visible, _id: "unrelated", name: "Other" },
    { ...visible, _id: "series", type: "series" },
  ];
  assert.deepEqual(
    cwDismissGroup(
      visible,
      copies,
      (n) => n.toLowerCase(),
      () => null,
    ),
    [copies[0], copies[1], visible],
  );
});

test("Clear All covers aliases of each visible card in one pass", () => {
  const a: LibraryItem = { _id: "a", type: "series", name: "A", removed: false };
  const b: LibraryItem = { ...a, _id: "b", name: "B" };
  const alias = { ...a, _id: "a-alias", name: "Alternate" };
  const root = (id: string) => (id.startsWith("a") ? "root-a" : null);
  const ids = new Set(
    [a, b]
      .flatMap((item) => cwDismissGroup(item, [a, b, alias], (n) => n, root))
      .map((item) => item._id),
  );
  assert.deepEqual([...ids].sort(), ["a", "a-alias", "b"]);
});
