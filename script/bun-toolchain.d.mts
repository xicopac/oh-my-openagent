import type { SpawnSyncReturns } from "node:child_process"

export type BunVersionSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly encoding: "utf8"; readonly stdio: readonly ["ignore", "pipe", "pipe"] },
) => Pick<SpawnSyncReturns<string>, "error" | "status" | "stderr" | "stdout">

export declare function parseBunPackageManager(value: unknown): string
export declare function expectedBunVersion(): string
export declare function assertBunVersion(actual: string | undefined, expected?: string, context?: string): string
export declare function assertCurrentBunVersion(context?: string): string
export declare function assertBunExecutableVersion(
  executable: string,
  expected?: string,
  context?: string,
  spawn?: BunVersionSpawn,
): string
