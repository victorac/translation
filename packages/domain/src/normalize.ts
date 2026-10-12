/** Amendment A1: normalize line endings to \n once, at the import boundary. */
export function normalizeSource(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
