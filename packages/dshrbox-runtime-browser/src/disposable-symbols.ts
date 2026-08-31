type DisposableSymbolConstructor = SymbolConstructor & {
  asyncDispose?: symbol;
  dispose?: symbol;
};

/** Install the explicit-resource-management symbols missing from older WebKit. */
export function installDisposableSymbols(
  symbolConstructor: DisposableSymbolConstructor = Symbol,
): void {
  installDisposableSymbol(symbolConstructor, "dispose");
  installDisposableSymbol(symbolConstructor, "asyncDispose");
}

function installDisposableSymbol(
  symbolConstructor: DisposableSymbolConstructor,
  name: "asyncDispose" | "dispose",
): void {
  const existing = symbolConstructor[name];
  if (existing !== undefined) {
    if (typeof existing !== "symbol") {
      throw new TypeError(`Symbol.${name} must be a symbol.`);
    }
    return;
  }
  Object.defineProperty(symbolConstructor, name, {
    value: symbolConstructor(`Symbol.${name}`),
  });
}

installDisposableSymbols();
