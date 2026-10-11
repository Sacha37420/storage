/**
 * File d'envoi : quelques envois en parallèle, progression par fichier,
 * annulation, relance. Ne connaît ni Angular ni HTTP — l'envoi réel est une
 * fonction injectée (`Sender`), ce qui rend la file testable avec un faux
 * expéditeur (upload-queue.spec.ts).
 */
import { uniqueName } from './entries';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled';

export interface UploadItem<P = unknown> {
  id: number;
  namespace: string;
  /** Chemin complet de destination dans l'espace. */
  path: string;
  name: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  error?: string;
  /** false : relancer ne servirait à rien (fichier trop gros, par exemple). */
  retryable: boolean;
  payload: P;
}

export interface SendHandle<R> { done: Promise<R>; abort(): void; }
export type Sender<P, R> = (item: UploadItem<P>, onProgress: (loaded: number, total: number) => void) => SendHandle<R>;

export interface QueueOptions<P, R> {
  concurrency?: number;
  /** Appelé après tout changement d'état, avec une COPIE de la liste. */
  onChange?: (items: UploadItem<P>[]) => void;
  onDone?: (item: UploadItem<P>, result: R) => void;
  describeError?: (err: unknown) => string;
}

export interface NewUpload<P> { namespace: string; path: string; size: number; payload: P; }

export class UploadQueue<P, R> {
  private items: UploadItem<P>[] = [];
  private handles = new Map<number, SendHandle<R>>();
  private nextId = 1;
  private readonly concurrency: number;

  constructor(private sender: Sender<P, R>, private opts: QueueOptions<P, R> = {}) {
    this.concurrency = opts.concurrency ?? 2;
  }

  list(): UploadItem<P>[] { return this.items.map(i => ({ ...i })); }

  add(uploads: readonly NewUpload<P>[]): void {
    for (const u of uploads) this.items.push(this.make(u, 'queued'));
    this.pump();
    this.emit();
  }

  /** Ajoute un élément directement en échec, non relançable (refus avant envoi). */
  addRejected(upload: NewUpload<P>, error: string): void {
    this.items.push({ ...this.make(upload, 'error'), error, retryable: false });
    this.emit();
  }

  cancel(id: number): void {
    const item = this.find(id);
    if (!item || (item.status !== 'queued' && item.status !== 'uploading')) return;
    this.handles.get(id)?.abort();
    this.handles.delete(id);
    item.status = 'canceled';
    this.pump();
    this.emit();
  }

  cancelAll(): void {
    for (const item of this.items) {
      if (item.status === 'queued' || item.status === 'uploading') {
        this.handles.get(item.id)?.abort();
        this.handles.delete(item.id);
        item.status = 'canceled';
      }
    }
    this.emit();
  }

  retry(id: number): void {
    const item = this.find(id);
    if (!item || !item.retryable || (item.status !== 'error' && item.status !== 'canceled')) return;
    item.status = 'queued';
    item.loaded = 0;
    item.error = undefined;
    this.pump();
    this.emit();
  }

  /** Retire de la liste tout ce qui n'est plus en cours ni en attente. */
  clearFinished(): void {
    this.items = this.items.filter(i => i.status === 'queued' || i.status === 'uploading');
    this.emit();
  }

  /** Chemins en attente ou en cours pour un espace : à traiter comme déjà pris. */
  activePaths(namespace: string): string[] {
    return this.items
      .filter(i => i.namespace === namespace && (i.status === 'queued' || i.status === 'uploading'))
      .map(i => i.path);
  }

  private make(u: NewUpload<P>, status: UploadStatus): UploadItem<P> {
    return {
      id: this.nextId++, namespace: u.namespace, path: u.path, name: u.path.split('/').pop() ?? u.path,
      size: u.size, loaded: 0, status, retryable: true, payload: u.payload,
    };
  }

  private find(id: number): UploadItem<P> | undefined { return this.items.find(i => i.id === id); }

  private pump(): void {
    let running = this.items.filter(i => i.status === 'uploading').length;
    for (const item of this.items) {
      if (running >= this.concurrency) break;
      if (item.status !== 'queued') continue;
      this.start(item);
      running++;
    }
  }

  private start(item: UploadItem<P>): void {
    item.status = 'uploading';
    item.loaded = 0;
    const handle = this.sender(item, (loaded, total) => {
      if (item.status !== 'uploading') return;
      // `total` est la taille du CORPS de la requête (enveloppe multipart
      // comprise), pas celle du fichier : on ne garde que la proportion.
      item.loaded = total > 0 ? Math.min(item.size, Math.round((item.size * loaded) / total)) : Math.min(item.size, loaded);
      this.emit();
    });
    this.handles.set(item.id, handle);
    handle.done.then(
      result => {
        if (this.handles.get(item.id) !== handle) return; // annulé ou relancé entre-temps
        this.handles.delete(item.id);
        item.status = 'done';
        item.loaded = item.size;
        this.opts.onDone?.(item, result);
        this.pump();
        this.emit();
      },
      err => {
        if (this.handles.get(item.id) !== handle) return;
        this.handles.delete(item.id);
        // Un échec n'arrête jamais la file : les suivants partent quand même.
        item.status = 'error';
        item.error = this.opts.describeError?.(err) ?? 'Envoi impossible.';
        this.pump();
        this.emit();
      },
    );
  }

  private emit(): void { this.opts.onChange?.(this.list()); }
}

// ── Conflits de nom ─────────────────────────────────────────────────────────

export interface Candidate<P> { path: string; size: number; payload: P; }
export interface UploadPlan<P> { free: Candidate<P>[]; conflicts: Candidate<P>[]; }
export type ConflictMode = 'replace' | 'keep-both' | 'skip';

/**
 * Sépare ce qui peut partir tel quel de ce qui écraserait quelque chose.
 * `taken` : chemins déjà occupés (fichiers existants, envois en cours, et
 * noms de dossiers — un fichier ne doit pas prendre le nom d'un dossier).
 * Deux candidats visant le même chemin : le second est un conflit.
 */
export function planUploads<P>(candidates: readonly Candidate<P>[], taken: ReadonlySet<string>): UploadPlan<P> {
  const seen = new Set<string>();
  const plan: UploadPlan<P> = { free: [], conflicts: [] };
  for (const c of candidates) {
    if (taken.has(c.path) || seen.has(c.path)) plan.conflicts.push(c);
    else { plan.free.push(c); seen.add(c.path); }
  }
  return plan;
}

/** Applique le choix de l'utilisateur aux conflits et renvoie la liste finale à envoyer. */
export function resolveConflicts<P>(plan: UploadPlan<P>, mode: ConflictMode, taken: ReadonlySet<string>): Candidate<P>[] {
  if (mode === 'skip') return [...plan.free];
  if (mode === 'replace') {
    // Un doublon interne au lot ne peut pas « remplacer » son jumeau : le dernier gagne.
    const byPath = new Map<string, Candidate<P>>();
    for (const c of [...plan.free, ...plan.conflicts]) byPath.set(c.path, c);
    return [...byPath.values()];
  }
  const used = new Set([...taken, ...plan.free.map(c => c.path)]);
  const renamed = plan.conflicts.map(c => {
    const slash = c.path.lastIndexOf('/');
    const dir = slash === -1 ? '' : c.path.slice(0, slash + 1);
    const siblings = new Set([...used].filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/')).map(p => p.slice(dir.length)));
    const path = dir + uniqueName(c.path.slice(dir.length), siblings);
    used.add(path);
    return { ...c, path };
  });
  return [...plan.free, ...renamed];
}
