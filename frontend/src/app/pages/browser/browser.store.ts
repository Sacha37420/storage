import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Router } from '@angular/router';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { catchError, of } from 'rxjs';

import { ApiService, Me, Share, SharesResponse, ShareTreeNode, StoredFile } from '../../core/api.service';
import { KeycloakService } from '../../core/keycloak.service';
import { ACTIONS, ActionContext, ActionHost, FileAction } from './logic/actions';
import {
  Entry, SortKey, SortState, buildEntries, filesOfEntries, filterEntries, folderNameError, formatSize, joinPath,
  prefixOf, sortEntries,
} from './logic/entries';
import {
  EMPTY_SELECTION, CursorMove, SelectionState, clearSelection, lasso, moveCursor, prune, selectAll, selectOnly,
  selectRange, toggle,
} from './logic/selection';
import {
  Candidate, ConflictMode, UploadItem, UploadPlan, UploadQueue, planUploads, resolveConflicts,
} from './logic/upload-queue';

export function extractError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error;
    if (typeof body === 'string' && body.length < 300) return body;
    if (body && typeof body === 'object') {
      const first = Object.values(body as Record<string, unknown>)[0];
      if (Array.isArray(first)) return String(first[0]);
      if (typeof first === 'string') return first;
      if (body.detail) return String(body.detail);
    }
    return err.status ? `Erreur ${err.status}` : 'Serveur injoignable.';
  }
  return 'Erreur inattendue.';
}

/** Un fichier choisi ou déposé, avec son chemin relatif à la cible ('sous/dossier/nom.ext'). */
export interface DroppedFile { file: File; relPath: string; }

export interface PendingDelete {
  namespace: string;
  files: StoredFile[];
  /** Dossiers créés dans l'interface et jamais matérialisés, retirés du même geste. */
  pendingFolders: string[];
  label: string;
  expiresAt: number;
}

export interface ConflictRequest {
  namespace: string;
  plan: UploadPlan<File>;
  taken: Set<string>;
}

/** Durée pendant laquelle une suppression peut être annulée. */
export const UNDO_DELAY_MS = 7000;
const SORT_STORAGE_KEY = 'storage-sort';

function findNode(nodes: readonly ShareTreeNode[], name: string): ShareTreeNode | null {
  for (const n of nodes) {
    if (n.name === name) return n;
    const found = findNode(n.children ?? [], name);
    if (found) return found;
  }
  return null;
}

function loadSort(): SortState {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? 'null');
    if (raw && ['name', 'size', 'date'].includes(raw.key) && ['asc', 'desc'].includes(raw.dir)) return raw;
  } catch { /* valeur illisible : tri par défaut */ }
  return { key: 'name', dir: 'asc' };
}

/**
 * État de l'explorateur. Les composants lisent ces signaux et déclenchent les
 * méthodes ; la logique elle-même est dans logic/ (fonctions pures, testées).
 * Fourni par BrowserComponent : une instance par page.
 */
@Injectable()
export class BrowserStore implements ActionHost {
  private api = inject(ApiService);
  private kc = inject(KeycloakService);
  private router = inject(Router);
  private announcer = inject(LiveAnnouncer);

  // ── Identité et espaces ────────────────────────────────────────────────
  readonly me = signal<Me | null>(null);
  readonly shares = signal<SharesResponse | null>(null);

  // ── Emplacement courant ────────────────────────────────────────────────
  readonly namespace = signal('');
  /** Dossier courant, sans '/' final ; '' = racine de l'espace. */
  readonly path = signal('');
  readonly allFiles = signal<StoredFile[]>([]);
  readonly loading = signal(true);
  /** Erreur de chargement de l'espace : il n'y a alors rien à afficher. */
  readonly loadError = signal<string | null>(null);
  /** Erreur d'une action : bandeau au-dessus de la liste, qui reste visible. */
  readonly notice = signal<string | null>(null);

  // ── Vue ────────────────────────────────────────────────────────────────
  readonly sort = signal<SortState>(loadSort());
  readonly filter = signal('');
  readonly selection = signal<SelectionState>(EMPTY_SELECTION);
  /** Chemins '<espace>\n<chemin>' des dossiers créés ici et encore vides. */
  private readonly pendingFolders = signal<string[]>([]);

  // ── Suppression annulable, envois, conflits ────────────────────────────
  readonly pendingDelete = signal<PendingDelete | null>(null);
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  readonly uploads = signal<UploadItem<File>[]>([]);
  readonly conflict = signal<ConflictRequest | null>(null);
  readonly folderDialog = signal(false);

  /** Branchements vers le DOM, posés par BrowserComponent (sélecteurs de fichiers, champ de filtre). */
  ui: { pickFiles(): void; pickFolder(): void; focusFilter(): void } = {
    pickFiles: () => undefined, pickFolder: () => undefined, focusFilter: () => undefined,
  };

  private readonly queue = new UploadQueue<File, StoredFile>(
    (item, onProgress) => {
      let sub: { unsubscribe(): void } | null = null;
      const done = new Promise<StoredFile>((resolve, reject) => {
        sub = this.api.uploadFile(item.namespace, item.path, item.payload).subscribe({
          next: event => {
            if (event.type === HttpEventType.UploadProgress) onProgress(event.loaded, event.total ?? item.size);
            else if (event.type === HttpEventType.Response && event.body) resolve(event.body);
          },
          error: reject,
        });
      });
      return { done, abort: () => sub?.unsubscribe() };
    },
    {
      concurrency: 2,
      onChange: items => this.uploads.set(items),
      onDone: (item, stored) => this.onUploaded(item.namespace, stored),
      describeError: extractError,
    },
  );

  // ── Dérivés ────────────────────────────────────────────────────────────

  /** Fichiers de l'espace courant, moins ceux dont la suppression est en attente. */
  readonly files = computed<StoredFile[]>(() => {
    const pending = this.pendingDelete();
    const all = this.allFiles();
    if (!pending || pending.namespace !== this.namespace()) return all;
    const gone = new Set(pending.files.map(f => f.relative_path));
    return all.filter(f => !gone.has(f.relative_path));
  });

  private readonly localFolders = computed<string[]>(() => {
    const head = `${this.namespace()}\n`;
    return this.pendingFolders().filter(k => k.startsWith(head)).map(k => k.slice(head.length));
  });

  /** Tout le dossier courant, avant filtre — sert aussi à détecter les noms pris. */
  readonly folderEntries = computed<Entry[]>(() => buildEntries(this.files(), this.path(), this.localFolders()));

  /** Ce qui est affiché : filtré puis trié. */
  readonly entries = computed<Entry[]>(() => sortEntries(filterEntries(this.folderEntries(), this.filter()), this.sort()));
  readonly order = computed<string[]>(() => this.entries().map(e => e.id));
  readonly selectedEntries = computed<Entry[]>(() => {
    const sel = this.selection().selected;
    return this.entries().filter(e => sel.has(e.id));
  });

  readonly breadcrumb = computed<{ name: string; path: string }[]>(() => {
    const segments = this.path() ? this.path().split('/') : [];
    return segments.map((name, i) => ({ name, path: segments.slice(0, i + 1).join('/') }));
  });

  readonly currentNode = computed<ShareTreeNode | null>(() => findNode(this.shares()?.tree ?? [], this.namespace()));

  readonly isPersonal = computed(() => !!this.me() && this.namespace() === this.me()!.username);

  /**
   * Droit d'écriture tel que le backend le calcule (`can_write` de l'arbre des
   * partages) — et non « c'est mon partage », qui privait de l'interface les
   * membres en écriture et les membres d'un groupe.
   */
  readonly canWrite = computed<boolean>(() => this.isPersonal() || this.currentNode()?.can_write === true);

  readonly isOwnedShare = computed<boolean>(() => (this.shares()?.owned ?? []).some(s => s.name === this.namespace()));

  readonly currentShare = computed<Share | null>(() => {
    const ns = this.namespace();
    const all = this.shares();
    return all?.owned.find(s => s.name === ns) ?? all?.member_of.find(s => s.name === ns) ?? null;
  });

  /**
   * Nom de l'application qui gère ce partage, ou null. Seul indice donné par
   * l'API actuelle : un propriétaire `service:<client>` (partage créé par un
   * compte de service). Un partage d'app provisionné à la main au nom d'un
   * compte humain (create_group_share) n'est PAS reconnaissable ici.
   */
  readonly managedBy = computed<string | null>(() => {
    const owner = this.currentNode()?.owner_username ?? '';
    if (!owner.startsWith('service:')) return null;
    return owner.slice('service:'.length).replace(/-admin$/, '');
  });

  /** Espace occupé par l'espace courant. */
  readonly usage = computed(() => formatSize(this.files().reduce((sum, f) => sum + f.size, 0)));

  readonly actionContext = computed<ActionContext>(() => ({
    selection: this.selectedEntries(),
    total: this.entries().length,
    canWrite: this.canWrite(),
    atRoot: !this.path(),
  }));

  readonly uploadSummary = computed(() => {
    const items = this.uploads();
    const active = items.filter(i => i.status === 'queued' || i.status === 'uploading').length;
    const failed = items.filter(i => i.status === 'error').length;
    const done = items.filter(i => i.status === 'done').length;
    const loaded = items.reduce((s, i) => s + (i.status === 'done' ? i.size : i.loaded), 0);
    const total = items.reduce((s, i) => s + i.size, 0);
    return { total: items.length, active, failed, done, percent: total ? Math.round((100 * loaded) / total) : 0 };
  });

  // ── Chargement et navigation ───────────────────────────────────────────

  init(): void {
    this.api.getMe().subscribe(me => {
      this.me.set(me);
      this.refreshShares();
      if (!this.namespace()) this.setLocation(me.username, '');
    });
  }

  refreshShares(): void {
    this.api.getShares().subscribe(shares => this.shares.set(shares));
  }

  /** Appelé à chaque changement d'URL. L'espace n'est rechargé que s'il change. */
  setLocation(namespace: string, path: string): void {
    const ns = namespace || this.me()?.username || '';
    const changed = ns !== this.namespace();
    this.namespace.set(ns);
    this.path.set(path);
    this.filter.set('');
    this.selection.set(EMPTY_SELECTION);
    if (changed && ns) this.reload();
  }

  reload(): void {
    const namespace = this.namespace();
    this.loading.set(true);
    this.loadError.set(null);
    this.api.listFiles(namespace)
      .pipe(catchError((err: HttpErrorResponse) => {
        this.loadError.set(extractError(err));
        return of<StoredFile[]>([]);
      }))
      .subscribe(files => {
        if (namespace !== this.namespace()) return; // réponse d'un espace déjà quitté
        this.allFiles.set(files);
        this.loading.set(false);
        this.selection.update(s => prune(s, this.order()));
      });
  }

  goTo(namespace: string, path = ''): void {
    void this.router.navigate(['/', namespace, ...(path ? path.split('/') : [])]);
  }

  /** Segments de route d'un dossier de l'espace courant (pour routerLink). */
  linkTo(path: string): string[] {
    return ['/', this.namespace(), ...(path ? path.split('/') : [])];
  }

  // ── Sélection ──────────────────────────────────────────────────────────

  click(id: string, mods: { ctrl: boolean; shift: boolean }): void {
    const order = this.order();
    if (mods.shift) this.selection.update(s => selectRange(s, order, id, mods.ctrl));
    else if (mods.ctrl) this.selection.update(s => toggle(s, id));
    else this.selection.set(selectOnly(id));
    this.announceSelection();
  }

  toggle(id: string): void {
    this.selection.update(s => toggle(s, id));
    this.announceSelection();
  }

  move(move: CursorMove, opts: { extend?: boolean; keep?: boolean }): void {
    this.selection.update(s => moveCursor(s, this.order(), move, opts));
  }

  setLasso(base: ReadonlySet<string>, touched: string[]): void {
    this.selection.update(s => lasso(base, touched, s));
  }

  selectAll(): void {
    this.selection.update(s => selectAll(s, this.order()));
    this.announceSelection();
  }

  clearSelection(): void {
    this.selection.update(clearSelection);
  }

  setFilter(text: string): void {
    this.filter.set(text);
    this.selection.update(s => prune(s, this.order()));
  }

  toggleSort(key: SortKey): void {
    this.sort.update(s => (s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'name' ? 'asc' : 'desc' }));
    try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(this.sort())); } catch { /* stockage indisponible */ }
  }

  private announceSelection(): void {
    const n = this.selection().selected.size;
    void this.announcer.announce(n === 0 ? 'Aucun élément sélectionné' : n === 1 ? '1 élément sélectionné' : `${n} éléments sélectionnés`);
  }

  // ── Actions (ActionHost) ───────────────────────────────────────────────

  run(action: FileAction): void {
    const ctx = this.actionContext();
    if (action.visible(ctx)) action.run(this, ctx);
  }

  runById(id: string): void {
    const action = ACTIONS.find(a => a.id === id);
    if (action) this.run(action);
  }

  open(entry: Entry): void {
    if (entry.kind === 'folder') this.goTo(this.namespace(), entry.path);
  }

  goParent(): void {
    const segments = this.path().split('/');
    segments.pop();
    this.goTo(this.namespace(), segments.join('/'));
  }

  pickFiles(): void { this.ui.pickFiles(); }
  pickFolder(): void { this.ui.pickFolder(); }
  focusFilter(): void { this.ui.focusFilter(); }
  newFolder(): void { this.folderDialog.set(true); }

  /** Télécharge les fichiers de la sélection, l'un après l'autre (les dossiers sont ignorés : pas d'archive pour l'instant). */
  download(entries: readonly Entry[]): void {
    const files = entries.filter(e => e.kind === 'file' && e.file).map(e => e.file!);
    const next = (i: number): void => {
      if (i >= files.length) return;
      const f = files[i];
      this.api.downloadFile(f.namespace, f.relative_path).subscribe({
        next: blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = f.relative_path.split('/').pop() ?? 'fichier';
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          setTimeout(() => next(i + 1), 150);
        },
        error: err => {
          this.notice.set(`Téléchargement de « ${f.relative_path} » impossible : ${extractError(err)}`);
          next(i + 1);
        },
      });
    };
    next(0);
  }

  // ── Suppression définitive, annulable quelques secondes ────────────────
  //
  // Décision du propriétaire : pas de corbeille. Les éléments disparaissent
  // tout de suite de la liste ; l'appel DELETE ne part qu'à l'expiration du
  // bandeau « Annuler ». Si l'onglet est fermé ou rechargé entre-temps, la
  // suppression est VALIDÉE (flushPendingDelete, requêtes keepalive) : fermer
  // la page n'est pas un moyen d'annuler. Une seule suppression en attente à
  // la fois — en lancer une seconde valide la première.

  remove(entries: readonly Entry[]): void {
    if (!this.canWrite() || entries.length === 0) return;
    this.commitPendingDelete();
    const namespace = this.namespace();
    const files = filesOfEntries(this.allFiles(), entries);
    const pendingFolders = entries.filter(e => e.pending).map(e => `${namespace}\n${e.path}`);
    const n = entries.length;
    const what = n === 1 ? `« ${entries[0].name} » supprimé` : `${n} éléments supprimés`;
    const detail = entries.some(e => e.kind === 'folder') ? ` (${files.length} fichier${files.length > 1 ? 's' : ''})` : '';
    this.pendingFolders.update(list => list.filter(k => !pendingFolders.includes(k)));
    this.pendingDelete.set({ namespace, files, pendingFolders, label: what + detail, expiresAt: Date.now() + UNDO_DELAY_MS });
    this.selection.update(s => prune(s, this.order()));
    this.deleteTimer = setTimeout(() => this.commitPendingDelete(), UNDO_DELAY_MS);
    void this.announcer.announce(`${what}. Annulation possible pendant ${UNDO_DELAY_MS / 1000} secondes.`);
  }

  undoDelete(): void {
    const pending = this.pendingDelete();
    if (!pending) return;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = null;
    this.pendingFolders.update(list => [...list, ...pending.pendingFolders]);
    this.pendingDelete.set(null);
    void this.announcer.announce('Suppression annulée.');
  }

  /** Envoie réellement les DELETE. Appelé à l'expiration du bandeau, ou avant une nouvelle suppression. */
  commitPendingDelete(): void {
    const pending = this.pendingDelete();
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = null;
    if (!pending) return;
    // Retirés de la liste AVANT de lever le bandeau, pour qu'ils ne réapparaissent pas un instant.
    const gone = new Set(pending.files.map(f => f.relative_path));
    if (pending.namespace === this.namespace()) this.allFiles.update(list => list.filter(f => !gone.has(f.relative_path)));
    this.pendingDelete.set(null);

    const failed: string[] = [];
    let index = 0;
    let running = 0;
    const pump = (): void => {
      while (running < 4 && index < pending.files.length) {
        const f = pending.files[index++];
        running++;
        this.api.deleteFile(f.namespace, f.relative_path).subscribe({
          // 404 : déjà supprimé ailleurs — le résultat voulu est atteint.
          error: (err: HttpErrorResponse) => { if (err.status !== 404) failed.push(f.relative_path); settle(); },
          complete: () => settle(),
        });
      }
    };
    const settle = (): void => {
      running--;
      if (index < pending.files.length) { pump(); return; }
      if (running === 0 && failed.length) {
        this.notice.set(`${failed.length} fichier${failed.length > 1 ? 's' : ''} n'${failed.length > 1 ? 'ont' : 'a'} pas pu être supprimé${failed.length > 1 ? 's' : ''}.`);
        if (pending.namespace === this.namespace()) this.reload();
      }
    };
    pump();
  }

  /** Page en cours de fermeture : valide la suppression en attente par des requêtes qui survivent au déchargement. */
  flushPendingDelete(): void {
    const pending = this.pendingDelete();
    if (!pending) return;
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = null;
    this.pendingDelete.set(null);
    const token = this.kc.getToken();
    if (!token) return;
    for (const f of pending.files) this.api.deleteFileOnUnload(f.namespace, f.relative_path, token);
  }

  // ── Dossiers ───────────────────────────────────────────────────────────
  //
  // L'API n'a pas d'objet « dossier » : un dossier n'existe que par les
  // fichiers qu'il contient. « Nouveau dossier » crée donc un dossier LOCAL à
  // cette page, affiché dans la liste, qui devient réel au premier fichier
  // déposé dedans et disparaît au rechargement s'il est resté vide.

  folderNameError(name: string): string | null {
    return folderNameError(name, new Set(this.folderEntries().map(e => e.name)));
  }

  createFolder(name: string): boolean {
    if (this.folderNameError(name)) return false;
    const path = joinPath(this.path(), name.trim());
    this.pendingFolders.update(list => [...list, `${this.namespace()}\n${path}`]);
    this.filter.set('');
    this.selection.set(selectOnly(`d:${path}`));
    this.folderDialog.set(false);
    return true;
  }

  // ── Téléversement ──────────────────────────────────────────────────────

  /**
   * Point d'entrée unique : sélecteur de fichiers, sélecteur de dossier,
   * glisser-déposer, coller. `targetFolder` : dossier de destination dans
   * l'espace courant. Rien n'est jamais écrasé sans un choix explicite.
   */
  requestUpload(dropped: readonly DroppedFile[], targetFolder: string): void {
    if (!this.canWrite() || dropped.length === 0) return;
    const namespace = this.namespace();
    const max = this.api.maxUploadBytes;
    const candidates: Candidate<File>[] = [];
    for (const d of dropped) {
      const path = prefixOf(targetFolder) + d.relPath;
      if (d.file.size > max) {
        this.queue.addRejected({ namespace, path, size: d.file.size, payload: d.file }, `Trop volumineux (maximum ${formatSize(max)})`);
      } else {
        candidates.push({ path, size: d.file.size, payload: d.file });
      }
    }
    if (candidates.length === 0) return;

    // Chemins pris : fichiers existants, envois en cours, et tout dossier
    // (un fichier « photos » à côté d'un dossier « photos » serait ambigu).
    const taken = new Set<string>([...this.files().map(f => f.relative_path), ...this.queue.activePaths(namespace)]);
    for (const f of this.files()) {
      const parts = f.relative_path.split('/');
      for (let i = 1; i < parts.length; i++) taken.add(parts.slice(0, i).join('/'));
    }
    const plan = planUploads(candidates, taken);
    if (plan.conflicts.length === 0) this.enqueue(namespace, plan.free);
    else this.conflict.set({ namespace, plan, taken });
  }

  resolveConflict(mode: ConflictMode | 'cancel'): void {
    const request = this.conflict();
    this.conflict.set(null);
    if (!request || mode === 'cancel') return;
    this.enqueue(request.namespace, resolveConflicts(request.plan, mode, request.taken));
  }

  private enqueue(namespace: string, candidates: Candidate<File>[]): void {
    if (candidates.length === 0) return;
    this.queue.add(candidates.map(c => ({ namespace, path: c.path, size: c.size, payload: c.payload })));
    void this.announcer.announce(`${candidates.length} envoi${candidates.length > 1 ? 's' : ''} en file d'attente.`);
  }

  private onUploaded(namespace: string, stored: StoredFile): void {
    if (namespace !== this.namespace()) return;
    this.allFiles.update(list => [...list.filter(f => f.relative_path !== stored.relative_path), stored]);
    // Un dossier local qui vient de recevoir son premier fichier est devenu réel.
    const head = `${namespace}\n`;
    this.pendingFolders.update(list => list.filter(k => !(k.startsWith(head) && stored.relative_path.startsWith(`${k.slice(head.length)}/`))));
  }

  cancelUpload(id: number): void { this.queue.cancel(id); }
  retryUpload(id: number): void { this.queue.retry(id); }
  cancelAllUploads(): void { this.queue.cancelAll(); }
  clearFinishedUploads(): void { this.queue.clearFinished(); }
}
