/**
 * Find the ref for an outline entry by its exact role and name, e.g.
 * `refFor(outline, 'button "Announce ready"')`. Throws (with the outline in
 * the message) when no entry matches, so a fixture drift fails loudly.
 */
export function refFor(outline: string, roleAndName: string): string {
  const escapedRoleAndName = roleAndName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = outline.match(new RegExp(`- ${escapedRoleAndName} \\[ref=([^\\]\\s]+)\\]`));
  if (match?.[1] === undefined) {
    throw new Error(`No ref found for ${roleAndName} in:\n${outline}`);
  }
  return match[1];
}
