// Sherlock's runtime configuration (design "Data Models" SherlockConfig).
// Everything tunable lives here — the completion verb is configurable per
// R6, and the motion cadences are injected constants so tests can drive
// them deterministically.

/** Runtime configuration for one Sherlock session. */
export interface SherlockConfig {
  /** Completion-line verb (`✓ Brewed in 42s`); configurable per R6. */
  completionVerb: string;
  /** Whimsical working words cycled while the agent runs (R4). Rendered
   * with a trailing `…`. */
  workingWords: readonly string[];
  /** Render dim input/result detail under each activity line. */
  verbose: boolean;
  /** Directory that holds run directories. */
  runsBaseDir: string;
  /** Directory holding eval task definitions (<name>/task.json). */
  evalsDir: string;
  /** Where eval results JSON files land (the CLI's convention). */
  evalResultsDir: string;
  /** How often the working word is re-picked, in milliseconds. */
  wordCycleMs: number;
  /** Spinner glyph frame rate, frames per second. */
  glyphFps: number;
}

/** The R4 working-word list (rendered with a trailing `…`). */
export const DEFAULT_WORKING_WORDS: readonly string[] = [
  'Foraging',
  'Sifting',
  'Rummaging',
  'Ferreting',
  'Digging',
  'Scouring',
  'Tracing',
  'Poking around',
  'Connecting dots',
  'Following leads',
  'Chasing citations',
  'Dusting for clues',
  'Reading the fine print',
  'Peeking under rocks',
  'Untangling threads',
  'Consulting the archives',
  'Cross-examining the web',
  'Separating signal from noise',
  'Brewing',
];

/** Build a config from defaults plus overrides. */
export function createConfig(
  overrides: Partial<SherlockConfig> = {},
): SherlockConfig {
  return {
    completionVerb: 'Brewed',
    workingWords: DEFAULT_WORKING_WORDS,
    verbose: false,
    runsBaseDir: 'runs',
    evalsDir: 'evals/datasets',
    evalResultsDir: 'runs/eval-results',
    wordCycleMs: 6_000,
    glyphFps: 4,
    ...overrides,
  };
}
