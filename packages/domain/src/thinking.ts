/**
 * Some models write their thinking into the reply, between <think> tags. It is never part of the translation.
 * Removes a leading thinking section, including the case where only the closing tag is present
 * (the opening one was already part of the prompt). Text without such tags is returned unchanged.
 */
export function stripThinking(text: string): string {
  let out = text;
  const open = /^\s*<think(?:ing)?>/i.exec(out);
  const close = /<\/think(?:ing)?>/i.exec(out);
  if (close && (open || out.slice(0, close.index).trim() !== "")) {
    if (!open || open.index <= close.index) return out.slice(close.index + close[0].length).replace(/^\s+/, "");
  }
  if (open && !close) return ""; // still thinking when the reply ended
  return out;
}
