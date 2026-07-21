export const MOBILE_NAVIGATION_QUERY = "(max-width: 768px)";

export function isModalNavigationOpen(
  sidebarOpen: boolean,
  isMobileViewport: boolean,
): boolean {
  return sidebarOpen && isMobileViewport;
}
