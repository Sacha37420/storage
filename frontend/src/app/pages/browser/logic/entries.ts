/**
 * Logique pure de la liste : l'API renvoie une liste PLATE de fichiers par
 * espace ; les dossiers n'existent pas côté serveur, ils sont déduits ici des
 * préfixes de chemin. Aucun import Angular : tout ce fichier se teste sans
 * navigateur (entries.spec.ts).
 */

export interface FileMeta {
  namespace: string;
  relative_path: string;
  size: number;
  content_type: string;
  uploaded_by_email: string;
  created_at: string;
  updated_at: string;
}

export type EntryKind = 'folder' | 'file';

export interface Entry {
  /** Stable et unique dans un dossier : 'd:<chemin>' ou 'f:<chemin>'. */
  id: string;
  kind: EntryKind;
  name: string;
  /** Chemin complet dans l'espace, sans '/' final. */
  path: string;
  /** Fichier : sa taille. Dossier : somme de tout ce qu'il contient. */
  size: number;
  /** Fichier : sa date. Dossier : la plus récente de son contenu ; null s'il est vide. */
  updatedAt: string | null;
  /** Dossier : nombre de fichiers contenus, tous niveaux confondus. */
  count: number;
  file?: FileMeta;
  /** Dossier créé dans l'interface et encore vide : il n'existe pas côté serveur. */
  pending?: boolean;
}

export type SortKey = 'name' | 'size' | 'date';
export type SortDir = 'asc' | 'desc';
export interface SortState { key: SortKey; dir: SortDir; }

export function prefixOf(path: string): string {
  return path ? `${path}/` : '';
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/**
 * Entrées (dossiers puis fichiers, non triées) du dossier `folder`.
 * `pendingFolders` : chemins complets de dossiers créés dans l'interface et
 * pas encore matérialisés par un fichier.
 */
export function buildEntries(files: readonly FileMeta[], folder: string, pendingFolders: readonly string[] = []): Entry[] {
  const prefix = prefixOf(folder);
  const folders = new Map<string, Entry>();
  const out: Entry[] = [];

  for (const f of files) {
    if (!f.relative_path.startsWith(prefix)) continue;
    const rest = f.relative_path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      out.push({ id: `f:${f.relative_path}`, kind: 'file', name: rest, path: f.relative_path, size: f.size, updatedAt: f.updated_at, count: 1, file: f });
      continue;
    }
    const name = rest.slice(0, slash);
    let dir = folders.get(name);
    if (!dir) {
      const path = prefix + name;
      dir = { id: `d:${path}`, kind: 'folder', name, path, size: 0, updatedAt: null, count: 0 };
      folders.set(name, dir);
    }
    dir.size += f.size;
    dir.count += 1;
    if (!dir.updatedAt || f.updated_at > dir.updatedAt) dir.updatedAt = f.updated_at;
  }

  for (const path of pendingFolders) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest || rest.includes('/')) continue;
    if (!folders.has(rest)) {
      folders.set(rest, { id: `d:${path}`, kind: 'folder', name: rest, path, size: 0, updatedAt: null, count: 0, pending: true });
    }
  }

  return [...folders.values(), ...out];
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

/** Dossiers toujours avant les fichiers ; à égalité, ordre alphabétique. */
export function sortEntries(entries: readonly Entry[], sort: SortState): Entry[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    let cmp = 0;
    if (sort.key === 'size') cmp = a.size - b.size;
    else if (sort.key === 'date') cmp = (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '');
    if (cmp === 0) return collator.compare(a.name, b.name) * (sort.key === 'name' ? sign : 1);
    return cmp * sign;
  });
}

/** Minuscules sans accents, pour un filtre tolérant (« ete » trouve « Été »). */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function filterEntries(entries: readonly Entry[], text: string): Entry[] {
  const needle = normalize(text.trim());
  if (!needle) return [...entries];
  return entries.filter(e => normalize(e.name).includes(needle));
}

/** Tous les fichiers contenus dans le dossier `folder`, tous niveaux confondus. */
export function filesUnder(files: readonly FileMeta[], folder: string): FileMeta[] {
  const prefix = prefixOf(folder);
  return files.filter(f => f.relative_path.startsWith(prefix));
}

/** Fichiers réels désignés par une sélection (un dossier = tout son contenu), sans doublon. */
export function filesOfEntries(files: readonly FileMeta[], entries: readonly Entry[]): FileMeta[] {
  const seen = new Set<string>();
  const out: FileMeta[] = [];
  const add = (f: FileMeta) => { if (!seen.has(f.relative_path)) { seen.add(f.relative_path); out.push(f); } };
  for (const e of entries) {
    if (e.kind === 'file' && e.file) add(e.file);
    else if (e.kind === 'folder') filesUnder(files, e.path).forEach(add);
  }
  return out;
}

/** 'photo.jpg' → ['photo', '.jpg'] ; '.gitignore' et 'LISEZMOI' n'ont pas d'extension. */
export function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/** Premier nom libre : 'a.txt' → 'a (2).txt' → 'a (3).txt'. `taken` n'est pas modifié. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const [stem, ext] = splitName(name);
  const m = /^(.*) \((\d+)\)$/.exec(stem);
  const base = m ? m[1] : stem;
  let n = m ? Number(m[2]) + 1 : 2;
  while (taken.has(`${base} (${n})${ext}`)) n++;
  return `${base} (${n})${ext}`;
}

/** Mêmes règles que validate_relative_path côté backend, pour un seul segment. */
export function folderNameError(name: string, siblings: ReadonlySet<string>): string | null {
  const n = name.trim();
  if (!n) return 'Donnez un nom au dossier.';
  if (n.includes('/')) return 'Le nom ne peut pas contenir « / ».';
  if (n === '.' || n === '..') return 'Ce nom est réservé.';
  if (siblings.has(n)) return 'Un élément porte déjà ce nom ici.';
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
