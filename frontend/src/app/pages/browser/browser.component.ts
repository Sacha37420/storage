import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, ViewChild, effect, inject, signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { A11yModule } from '@angular/cdk/a11y';

import { BrowserStore, UNDO_DELAY_MS } from './browser.store';
import { carriesFiles, filesFromInput } from './parts/drop-files';
import { FileListComponent } from './parts/file-list.component';
import { IconComponent } from './parts/icon.component';
import { SharePanelComponent } from './parts/share-panel.component';
import { SpaceTreeComponent } from './parts/space-tree.component';
import { ToolbarComponent } from './parts/toolbar.component';
import { UploadPanelComponent } from './parts/upload-panel.component';

/**
 * Page de l'explorateur : met en place les pièces et relie l'URL au magasin.
 * L'état vit dans BrowserStore, la logique dans logic/, l'affichage dans parts/.
 */
@Component({
  selector: 'app-browser',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BrowserStore],
  imports: [
    RouterLink, A11yModule, FileListComponent, IconComponent, SharePanelComponent,
    SpaceTreeComponent, ToolbarComponent, UploadPanelComponent,
  ],
  templateUrl: './browser.component.html',
  styleUrl: './browser.component.scss',
})
export class BrowserComponent {
  protected store = inject(BrowserStore);
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);

  protected readonly undoSeconds = UNDO_DELAY_MS / 1000;
  protected drawerOpen = signal(false);
  protected managing = signal(false);
  protected folderName = '';
  protected folderError = signal<string | null>(null);

  @ViewChild('filesInput', { static: true }) private filesInput!: ElementRef<HTMLInputElement>;
  @ViewChild(ToolbarComponent, { static: true }) private toolbar!: ToolbarComponent;

  constructor() {
    this.store.ui = {
      pickFiles: () => this.filesInput.nativeElement.click(),
      pickFolder: () => undefined,
      focusFilter: () => this.toolbar.focusFilter(),
    };
    this.store.init();

    this.route.url.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(segments => {
      const parts = segments.map(s => s.path);
      this.store.setLocation(parts[0] ?? '', parts.slice(1).join('/'));
      this.managing.set(false);
    });

    // Le dialogue « Nouveau dossier » s'ouvre vide à chaque fois.
    effect(() => {
      if (this.store.folderDialog()) { this.folderName = ''; this.folderError.set(null); }
    });
  }

  protected onPicked(input: HTMLInputElement): void {
    this.store.requestUpload(filesFromInput(input), this.store.path());
    input.value = '';
  }

  protected submitFolder(): void {
    const error = this.store.folderNameError(this.folderName);
    this.folderError.set(error);
    if (!error) this.store.createFolder(this.folderName);
  }

  protected conflictNames(): string {
    const names = (this.store.conflict()?.plan.conflicts ?? []).map(c => c.path.split('/').pop());
    const shown = names.slice(0, 3).map(n => `« ${n} »`).join(', ');
    return names.length > 3 ? `${shown} et ${names.length - 3} autre${names.length - 3 > 1 ? 's' : ''}` : shown;
  }

  // Un fichier lâché hors d'une zone de dépôt ne doit jamais faire quitter la
  // page (comportement par défaut du navigateur : il ouvre le fichier).
  @HostListener('window:dragover', ['$event'])
  @HostListener('window:drop', ['$event'])
  protected blockStrayDrop(event: DragEvent): void {
    if (carriesFiles(event)) event.preventDefault();
  }

  /** Coller des fichiers (capture d'écran, fichier copié) = les téléverser dans le dossier courant. */
  @HostListener('window:paste', ['$event'])
  protected onPaste(event: ClipboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0 || !this.store.canWrite()) return;
    event.preventDefault();
    this.store.requestUpload(files.map(file => ({ file, relPath: file.name })), this.store.path());
  }

  // Fermeture ou rechargement : une suppression en attente d'annulation est validée.
  @HostListener('window:pagehide')
  protected onPageHide(): void { this.store.flushPendingDelete(); }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.store.conflict()) this.store.resolveConflict('cancel');
    else if (this.store.folderDialog()) this.store.folderDialog.set(false);
    else if (this.drawerOpen()) this.drawerOpen.set(false);
  }
}
