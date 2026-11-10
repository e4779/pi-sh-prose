/**
 * Engine-free stand-in for `pi-fabric/highlight` (Phase-0 port).
 * highlightCode returns the input unchanged — plain text rendering, no ANSI.
 * If highlight quality is missed later, bring shiki in as a direct dependency
 * behind this same interface instead of reintroducing the fabric engine.
 */
export function highlightCode(code: string, _lang?: string): string {
  return code;
}

export function observePiTheme(_theme: unknown): void {
  // no theme tracking on the stub
}
