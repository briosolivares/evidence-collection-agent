// Sherlock's runtime configuration (design "Data Models" SherlockConfig).

/** Runtime configuration for one Sherlock session. */
export interface SherlockConfig {
  /** Render dim input/result detail under each activity line. */
  verbose: boolean;
  /** Base directory each new run directory is created under. */
  runsBaseDir: string;
}

export function createConfig(overrides: Partial<SherlockConfig> = {}): SherlockConfig {
  return {
    verbose: false,
    runsBaseDir: 'runs',
    ...overrides,
  };
}
