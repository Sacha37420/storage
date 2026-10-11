import { DroppedFile } from '../browser.store';

/** Vrai si le glissé transporte des fichiers venus du système (et non du texte ou un élément de la page). */
export function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, ko: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (entries: FsEntry[]) => void, ko: (e: unknown) => void): void };
}

function readAll(reader: NonNullable<ReturnType<NonNullable<FsEntry['createReader']>>>): Promise<FsEntry[]> {
  // readEntries rend les entrées par paquets (100 dans Chromium) : il faut
  // rappeler jusqu'à recevoir un paquet vide, sinon un gros dossier est tronqué.
  return new Promise((resolve, reject) => {
    const all: FsEntry[] = [];
    const next = (): void => reader.readEntries(batch => {
      if (batch.length === 0) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
}

async function walk(entry: FsEntry, parent: string, out: DroppedFile[]): Promise<void> {
  const relPath = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, ko) => entry.file!(ok, ko));
    out.push({ file, relPath });
  } else if (entry.isDirectory && entry.createReader) {
    for (const child of await readAll(entry.createReader())) await walk(child, relPath, out);
  }
}

/**
 * Fichiers d'un dépôt, dossiers parcourus en profondeur avec leur chemin
 * relatif. Les entrées doivent être lues PENDANT l'événement `drop` (elles
 * sont invalidées dès qu'il se termine) : toute la partie synchrone est faite
 * avant le premier `await`.
 */
export async function filesFromDrop(dt: DataTransfer | null): Promise<DroppedFile[]> {
  if (!dt) return [];
  const roots: FsEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null;
    if (entry) roots.push(entry);
    else { const f = item.getAsFile(); if (f) loose.push(f); }
  }
  if (roots.length === 0 && loose.length === 0) loose.push(...Array.from(dt.files ?? []));

  const out: DroppedFile[] = loose.map(file => ({ file, relPath: file.name }));
  for (const root of roots) await walk(root, '', out);
  return out;
}

/** Fichiers d'un `<input type="file">`, y compris `webkitdirectory` (chemins relatifs conservés). */
export function filesFromInput(input: HTMLInputElement): DroppedFile[] {
  return Array.from(input.files ?? []).map(file => ({ file, relPath: file.webkitRelativePath || file.name }));
}
