const DSH_VERSION = "0.1.0-rc.6";

export function createRequire(filename: string | URL): (specifier: string) => unknown {
  void filename;
  return (specifier: string): unknown => {
    if (specifier.endsWith("package.json")) {
      return { version: DSH_VERSION };
    }
    throw new Error(`browser worker cannot require "${specifier}"`);
  };
}
