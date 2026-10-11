import { Directive, ElementRef, HostBinding, HostListener, inject, input } from '@angular/core';
import { BrowserStore } from '../browser.store';
import { carriesFiles, filesFromDrop } from './drop-files';

/**
 * Zone de dépôt de fichiers. `appFileDrop` reçoit le dossier de destination
 * (chemin dans l'espace courant). Posée sur la liste entière (dossier
 * courant), sur chaque ligne de dossier et sur chaque cran du fil d'Ariane :
 * la zone la plus intérieure l'emporte (stopPropagation).
 */
@Directive({ selector: '[appFileDrop]', standalone: true })
export class FileDropDirective {
  private store = inject(BrowserStore);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly target = input.required<string>({ alias: 'appFileDrop' });
  readonly dropDisabled = input(false);

  /** Compteur d'entrées/sorties : dragleave se déclenche aussi en survolant un enfant. */
  private depth = 0;

  @HostBinding('class.drop-over') over = false;

  private accepts(event: DragEvent): boolean {
    return !this.dropDisabled() && this.store.canWrite() && carriesFiles(event);
  }

  @HostListener('dragenter', ['$event'])
  onEnter(event: DragEvent): void {
    if (!this.accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.depth++;
    this.over = true;
  }

  @HostListener('dragover', ['$event'])
  onOver(event: DragEvent): void {
    if (!this.accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.over = true;
  }

  @HostListener('dragleave', ['$event'])
  onLeave(event: DragEvent): void {
    if (!this.accepts(event)) return;
    event.stopPropagation();
    this.depth = Math.max(0, this.depth - 1);
    const to = event.relatedTarget as Node | null;
    if (this.depth === 0 || (to && !this.host.nativeElement.contains(to))) { this.depth = 0; this.over = false; }
  }

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    if (!this.accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.depth = 0;
    this.over = false;
    const target = this.target();
    void filesFromDrop(event.dataTransfer).then(files => this.store.requestUpload(files, target));
  }
}
