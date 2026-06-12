export function hasScanNowArgument(argv: string[]): boolean {
  return argv.includes("--scan-now");
}

export function hasShowWindowArgument(argv: string[]): boolean {
  return argv.includes("--show-window");
}
