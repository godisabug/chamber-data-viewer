function sameSource(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}
export function mergeDataset<T extends { sourceId: string }>(current: T[], loaded: T, replaceSourceId?: string): T[] {
  const requestedReplaceIndex = replaceSourceId
    ? current.findIndex((item) => sameSource(item.sourceId, replaceSourceId))
    : -1;
  const loadedIndex = current.findIndex((item) => sameSource(item.sourceId, loaded.sourceId));
  const replaceIndex = requestedReplaceIndex >= 0 ? requestedReplaceIndex : loadedIndex;
  const isRemoved = (item: T): boolean => {
    const isLoaded = sameSource(item.sourceId, loaded.sourceId);
    const isReplaced = replaceSourceId ? sameSource(item.sourceId, replaceSourceId) : false;
    return isLoaded || isReplaced;
  };
  const next = current.filter((item) => !isRemoved(item));
  const insertionIndex = replaceIndex < 0
    ? next.length
    : current.slice(0, replaceIndex).filter((item) => !isRemoved(item)).length;
  next.splice(insertionIndex, 0, loaded);
  return next;
}
export function removeDataset<T extends { sourceId: string }>(current: T[], deletedSourceId: string, activeSourceId: string | null): { datasets: T[]; activeSourceId: string | null } {
  const deletedIndex = current.findIndex((item) => sameSource(item.sourceId, deletedSourceId));
  if (deletedIndex < 0) return { datasets: current, activeSourceId };
  const datasets = current.filter((item) => !sameSource(item.sourceId, deletedSourceId));
  if (activeSourceId === null) return { datasets, activeSourceId: null };
  if (sameSource(activeSourceId, deletedSourceId)) {
    const fallbackIndex = Math.min(deletedIndex, datasets.length - 1);
    return { datasets, activeSourceId: datasets[fallbackIndex]?.sourceId ?? null };
  }
  const activeStillExists = datasets.some((item) => sameSource(item.sourceId, activeSourceId));
  return { datasets, activeSourceId: activeStillExists ? activeSourceId : null };
}
export function moveDataset<T extends { sourceId: string }>(
  current: T[],
  sourceId: string,
  targetSourceId: string,
): T[] {
  const from = current.findIndex((item) => sameSource(item.sourceId, sourceId));
  const to = current.findIndex((item) => sameSource(item.sourceId, targetSourceId));
  if (from < 0 || to < 0 || from === to) return current;
  const next = [...current];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
