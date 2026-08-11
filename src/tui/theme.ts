// Andera palette tokens and transcript glyphs (design "Data Models" theme
// table). Colors are foreground-only — the terminal background is the
// user's — and Ink/chalk downsample automatically without truecolor.

/** Foreground color tokens, keyed by role. */
export const theme = {
  /** Primary accent — spinner glyph ✻, user prompt marker ▸ (purple300). */
  primary: '#A9A1E6',
  /** Evidence ◆ and emphasis (purple400). */
  emphasis: '#AEA4FF',
  /** Activity ● lines (purple600). */
  activity: '#786ECB',
  /** Muted metadata (`↳ … tokens · …s`) and dim hints (indigo-gray w500). */
  muted: '#7D7993',
  /** Success ✓. */
  success: '#00892B',
  /** Error ✗. */
  error: '#DC2626',
} as const;

/** Transcript and status glyphs. */
export const glyphs = {
  /** User task marker. */
  user: '▸',
  /** Routine tool-activity marker. */
  activity: '●',
  /** Evidence marker (stronger treatment). */
  evidence: '◆',
  /** Success marker. */
  success: '✓',
  /** Error / interruption marker. */
  error: '✗',
  /** Settled dangling tool line marker. */
  retried: '⚠',
  /** Metadata line prefix. */
  metadata: '↳',
  /** Evidence source-URL line prefix. */
  source: '└',
  /** Spinner frame cycle, ~4 fps. */
  spinnerFrames: ['✢', '✳', '✻', '✽'],
} as const;
