const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;

export function isAbsolute(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\\\") ||
    WINDOWS_DRIVE_ABSOLUTE.test(path)
  );
}
