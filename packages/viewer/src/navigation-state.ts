export const MOBILE_NAVIGATION_QUERY =
  "(max-width: 768px), (max-height: 500px) and (hover: none) and (pointer: coarse)";

export function isModalNavigationOpen(
  sidebarOpen: boolean,
  isMobileViewport: boolean,
): boolean {
  return sidebarOpen && isMobileViewport;
}

export function modalFocusTrapTarget({
  isFocusInside,
  isFocusFirst,
  isFocusLast,
  shiftKey,
}: {
  isFocusInside: boolean;
  isFocusFirst: boolean;
  isFocusLast: boolean;
  shiftKey: boolean;
}): "first" | "last" | null {
  if (!isFocusInside) return shiftKey ? "last" : "first";
  if (shiftKey && isFocusFirst) return "last";
  if (!shiftKey && isFocusLast) return "first";
  return null;
}
