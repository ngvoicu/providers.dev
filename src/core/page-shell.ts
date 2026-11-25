// These markers carry no dataset values at build time. `head` is the page's own part of <head>: its canonical link
// and, where a page is not to be indexed, its robots meta.
export const PAGE_SHELL = "/site-shell/";
export const MARK = { title: "%%PAGE_TITLE%%", description: "%%PAGE_DESCRIPTION%%", head: "%%PAGE_HEAD%%", html: "%%PAGE_HTML%%", nav: "%%PAGE_NAV%%", dataset: "%%PAGE_DATASET%%" } as const;

export function fillShell(shell: string, values: Record<keyof typeof MARK, string>): string {
  const replacements = new Map<string, string>(Object.entries(MARK).map(([key, marker]) => [marker, values[key as keyof typeof MARK]]));
  // One pass: values containing a marker are data, never template instructions.
  return shell.replace(/%%PAGE_[A-Z]+%%/g, (marker) => replacements.get(marker) ?? marker);
}
