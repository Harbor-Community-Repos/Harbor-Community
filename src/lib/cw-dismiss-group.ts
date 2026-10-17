import type { LibraryItem } from "./stremio";

/** Include source copies hidden by the Continue Watching row's deduplication. */
export function cwDismissGroup(
  visible: LibraryItem,
  candidates: LibraryItem[],
  titleKey: (name: string) => string,
  rootKey: (id: string) => string | null | undefined,
): LibraryItem[] {
  const name = titleKey(visible.name ?? "");
  const root = rootKey(visible._id);
  return [
    ...candidates.filter(
      (item) =>
        item._id === visible._id ||
        (item.type === visible.type && name !== "" && titleKey(item.name ?? "") === name) ||
        (root != null && rootKey(item._id) === root),
    ),
    visible,
  ];
}
