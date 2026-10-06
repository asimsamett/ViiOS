/** Leave enough room for magnification instead of clipping the Dock. */
export function dockLayout(width: number, itemCount: number) {
  const compact = width <= 760;
  const size = compact ? 36 : 54, gap = compact ? 6 : 10;
  const padding = compact ? 22 : 30;
  const available = Math.max(280, width) - (compact ? 16 : 32);
  const reserve = compact ? 0 : size * 2.6;
  const fullWidth = itemCount * (size + gap) - gap + padding;
  const paginated = fullWidth + reserve > available;
  // First and last entries (Start and Customize) remain on every page.
  const pageSize = Math.max(1, Math.floor((available - padding - 64 - reserve + gap) / (size + gap)) - 2);
  return { size, gap, pageSize, pages: paginated ? Math.max(1, Math.ceil(Math.max(0, itemCount - 2) / pageSize)) : 1 };
}
