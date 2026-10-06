export type DesktopBounds = { width: number; height: number };
export type WindowRect = DesktopBounds & { x: number; y: number };

// New windows float on desktop; compact screens fit without persisting maximize.
export function initialWindowState(
  bounds: DesktopBounds,
  preferredWidth = 1120,
  existingCount = 0,
): { minimized: false; maximized: false; rect: WindowRect } {
  const compact = bounds.width < 760;
  const rect = clampWindow({
    x: 0,
    y: 0,
    width: compact ? bounds.width : Math.min(preferredWidth, bounds.width - 64),
    height: compact ? bounds.height : Math.min(600, bounds.height - 72),
  }, bounds);
  const offset = compact ? 0 : (existingCount % 5) * 24;
  return {
    minimized: false,
    maximized: false,
    rect: clampWindow({
      ...rect,
      x: (bounds.width - rect.width) / 2 + offset,
      y: (bounds.height - rect.height) / 2 + offset,
    }, bounds),
  };
}

export function clampWindow(
  rect: WindowRect,
  bounds: DesktopBounds,
): WindowRect {
  const width = Math.min(
    bounds.width,
    Math.max(Math.min(540, bounds.width), rect.width),
  );
  const height = Math.min(
    bounds.height,
    Math.max(Math.min(360, bounds.height), rect.height),
  );
  return {
    width,
    height,
    x: Math.max(0, Math.min(rect.x, bounds.width - width)),
    y: Math.max(0, Math.min(rect.y, bounds.height - height)),
  };
}

// Reordering retains stable window IDs and therefore mounted editor state.
export function focusWindow<T extends { id: string; minimized: boolean }>(
  windows: T[],
  id: string,
): T[] {
  const window = windows.find((item) => item.id === id);
  if (!window || (windows.at(-1) === window && !window.minimized))
    return windows;
  return [
    ...windows.filter((item) => item.id !== id),
    { ...window, minimized: false },
  ];
}

export function activeWindow<T extends { id: string; minimized: boolean }>(
  windows: T[],
): string | undefined {
  return windows.findLast((item) => !item.minimized)?.id;
}
