export const MOBILE_NAVIGATION_QUERY = "(max-width: 768px)";

export function isModalNavigationOpen(
  sidebarOpen: boolean,
  isMobileViewport: boolean,
): boolean {
  return sidebarOpen && isMobileViewport;
}

export function navigationFocusTrapTarget({
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
