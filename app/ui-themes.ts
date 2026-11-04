export const uiThemes = [
  { id: 'indigo', name: 'Indigo', description: 'Clean and bright', canvas: '#f6f7f9', surface: '#ffffff', accent: '#365bd6' },
  { id: 'midnight', name: 'Midnight', description: 'A softer dark workspace', canvas: '#101621', surface: '#1a2332', accent: '#a4b7ff' },
  { id: 'ocean', name: 'Ocean', description: 'Calm teal tones', canvas: '#f2f7f7', surface: '#ffffff', accent: '#087c82' },
  { id: 'sand', name: 'Sand', description: 'Warm paper tones', canvas: '#f4efe6', surface: '#fffcf7', accent: '#b4492a' },
  { id: 'obsidian', name: 'Obsidian', description: 'True black for night', canvas: '#050608', surface: '#111317', accent: '#b9a2ff' },
] as const;

// The colour behind the app and in the phone's status and navigation bars.
export const themeCanvas = (id: string) => (uiThemes.find(theme => theme.id === id) ?? uiThemes[0]).canvas;

export type UITheme = typeof uiThemes[number]['id'];
export function isUITheme(value: unknown): value is UITheme {
  return uiThemes.some(theme => theme.id === value);
}
export function normalizeUITheme(value: unknown): UITheme {
  return isUITheme(value) ? value : 'indigo';
}
