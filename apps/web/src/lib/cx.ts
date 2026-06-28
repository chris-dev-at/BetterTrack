/** Tiny class-name joiner — shared by the `ui/` kit and feature areas alike. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
