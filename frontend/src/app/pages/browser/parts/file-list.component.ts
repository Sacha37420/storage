import { DatePipe } from '@angular/common';
import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, inject,
} from '@angular/core';
import { CdkContextMenuTrigger, CdkMenu, CdkMenuItem } from '@angular/cdk/menu';
import SelectionArea from '@viselect/vanilla';

import { BrowserStore } from '../browser.store';
import { FileAction, actionForKey, actionsFor, shortcutLabel } from '../logic/actions';
import { Entry, SortKey, formatSize } from '../logic/entries';
import { FileDropDirective } from './file-drop.directive';
import { IconComponent } from './icon.component';

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]');
}

/**
 * La liste : sélection (clic, Ctrl, Maj, rectangle, cases), clavier, menu
 * contextuel, dépôt de fichiers. Ne décide de rien : chaque geste est traduit
 * en appel au magasin, et chaque action vient de la table logic/actions.ts.
 */
@Component({
  selector: 'app-file-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, CdkContextMenuTrigger, CdkMenu, CdkMenuItem, FileDropDirective, IconComponent],
  templateUrl: './file-list.component.html',
  styleUrl: './file-list.component.scss',
})
export class FileListComponent implements AfterViewInit, OnDestroy {
  protected store = inject(BrowserStore);
  protected readonly formatSize = formatSize;
  protected readonly shortcutLabel = shortcutLabel;

  @ViewChild('zone', { static: true }) private zone!: ElementRef<HTMLElement>;
  @ViewChild(CdkContextMenuTrigger, { static: true }) private menuTrigger!: CdkContextMenuTrigger;

  protected readonly menuActions = computed<FileAction[]>(() => actionsFor(this.store.actionContext(), 'menu'));
  protected readonly allSelected = computed(() => {
    const total = this.store.entries().length;
    return total > 0 && this.store.selection().selected.size === total;
  });
  /** Ligne qui reçoit la tabulation : le curseur, sinon la première. */
  protected readonly tabStop = computed(() => this.store.selection().cursor ?? this.store.order()[0] ?? null);

  private area: SelectionArea | null = null;
  /** Vrai juste après un rectangle ou un appui long : le `click` qui suit ne doit rien faire. */
  private swallowClick = false;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressStart: { x: number; y: number } | null = null;

  // ── Rectangle de sélection ─────────────────────────────────────────────

  ngAfterViewInit(): void {
    let base: ReadonlySet<string> = new Set();
    this.area = new SelectionArea({
      selectables: ['.entry'],
      boundaries: [this.zone.nativeElement],
      selectionAreaClass: 'lasso',
      // Souris seulement : au doigt, un glissé fait défiler la page. Le tactile
      // sélectionne par les cases à cocher et par l'appui long.
      features: { touch: false, range: false, deselectOnBlur: false, singleTap: { allow: false } },
      behaviour: { startThreshold: 8, overlap: 'invert', scrolling: { startScrollMargins: { x: 0, y: 40 } } },
    });
    this.area.on('beforestart', ({ event }) => {
      const target = event?.target as HTMLElement | null;
      if (event instanceof MouseEvent && event.button !== 0) return false;
      // Pas de rectangle depuis un bouton, une case ou l'en-tête de colonnes.
      return !target?.closest('button, input, a, .head');
    });
    this.area.on('start', ({ event }) => {
      const additive = !!event && (event.ctrlKey || event.metaKey || event.shiftKey);
      base = additive ? new Set(this.store.selection().selected) : new Set();
      this.area?.clearSelection(true, true);
    });
    this.area.on('move', ({ store }) => {
      const touched = store.selected.map(el => (el as HTMLElement).dataset['id'] ?? '').filter(Boolean);
      this.store.setLasso(base, touched);
    });
    this.area.on('stop', () => {
      // Le focus revient dans la liste, pour que Suppr ou les flèches s'appliquent tout de suite.
      if (this.store.selection().cursor) this.focusCursor();
      else this.zone.nativeElement.querySelector<HTMLElement>('.grid')?.focus();
      this.swallowClick = true;
      setTimeout(() => { this.swallowClick = false; });
    });
  }

  ngOnDestroy(): void {
    this.area?.destroy();
    this.cancelPress();
  }

  // ── Souris et doigt ────────────────────────────────────────────────────

  protected onRowClick(event: MouseEvent, entry: Entry): void {
    event.stopPropagation();
    if (this.swallowClick) return;
    const touch = (event as PointerEvent).pointerType === 'touch';
    if (touch) {
      // Au doigt : toucher ouvre un dossier ; dès qu'une sélection existe, toucher coche.
      if (this.store.selection().selected.size > 0 || entry.kind === 'file') this.store.toggle(entry.id);
      else this.store.open(entry);
      return;
    }
    this.store.click(entry.id, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
  }

  protected onRowDblClick(event: MouseEvent, entry: Entry): void {
    event.stopPropagation();
    if (entry.kind === 'folder') this.store.open(entry);
    else this.store.download([entry]);
  }

  protected onCheck(event: Event, entry: Entry): void {
    event.stopPropagation();
    this.store.toggle(entry.id);
  }

  protected toggleAll(): void {
    if (this.allSelected()) this.store.clearSelection(); else this.store.selectAll();
  }

  /** Clic dans le vide de la liste : désélectionne. */
  protected onBackgroundClick(): void {
    if (this.swallowClick) return;
    if (this.store.selection().selected.size) this.store.clearSelection();
  }

  /**
   * Clic droit : s'exécute AVANT l'ouverture du menu (cet écouteur est sur un
   * élément intérieur à celui qui porte cdkContextMenuTriggerFor). Sur un
   * élément hors sélection, il devient la sélection ; dans le vide, elle se vide.
   */
  protected onContextMenu(event: MouseEvent): void {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.entry');
    const id = row?.dataset['id'];
    if (!id) this.store.clearSelection();
    else if (!this.store.selection().selected.has(id)) this.store.click(id, { ctrl: false, shift: false });
  }

  // Appui long (tactile) : même menu que le clic droit. Android déclenche
  // `contextmenu` de lui-même ; iOS non, d'où ce minuteur.
  protected onPointerDown(event: PointerEvent, entry: Entry): void {
    if (event.pointerType !== 'touch') return;
    this.cancelPress();
    this.pressStart = { x: event.clientX, y: event.clientY };
    const at = { x: event.clientX, y: event.clientY };
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      if (!this.store.selection().selected.has(entry.id)) this.store.click(entry.id, { ctrl: false, shift: false });
      this.swallowClick = true;
      setTimeout(() => { this.swallowClick = false; }, 400);
      this.menuTrigger.open(at);
    }, LONG_PRESS_MS);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.pressStart) return;
    if (Math.hypot(event.clientX - this.pressStart.x, event.clientY - this.pressStart.y) > LONG_PRESS_SLOP_PX) this.cancelPress();
  }

  protected cancelPress(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
    this.pressStart = null;
  }

  // ── Clavier ────────────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  protected onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    // Une boîte de dialogue ou un menu ouvert garde le clavier pour lui.
    if (document.querySelector('.modal, .cdk-overlay-pane')) return;
    const inList = this.zone.nativeElement.contains(event.target as Node);

    const action = actionForKey(event, this.store.actionContext(), inList);
    if (action) {
      event.preventDefault();
      this.store.run(action);
      if (action.id === 'select-all' || action.id === 'clear-selection') this.focusCursor();
      return;
    }
    if (!inList) return;

    const opts = { extend: event.shiftKey, keep: event.ctrlKey || event.metaKey };
    switch (event.key) {
      case 'ArrowDown': this.store.move(1, opts); break;
      case 'ArrowUp': this.store.move(-1, opts); break;
      case 'Home': this.store.move('first', opts); break;
      case 'End': this.store.move('last', opts); break;
      case 'PageDown': this.store.move(10, opts); break;
      case 'PageUp': this.store.move(-10, opts); break;
      case ' ': {
        const cursor = this.store.selection().cursor;
        if (!cursor) return;
        this.store.toggle(cursor);
        break;
      }
      case 'Enter': {
        // Entrée sur un fichier : le télécharge (pas encore d'aperçu). Sur un dossier : action « ouvrir » de la table.
        const sel = this.store.selectedEntries();
        if (sel.length !== 1 || sel[0].kind !== 'file') return;
        this.store.download(sel);
        break;
      }
      default: return;
    }
    event.preventDefault();
    this.focusCursor();
  }

  private focusCursor(): void {
    const id = this.store.selection().cursor;
    if (!id) return;
    setTimeout(() => {
      const row = this.zone.nativeElement.querySelector<HTMLElement>(`.entry[data-id="${CSS.escape(id)}"]`);
      row?.focus({ preventScroll: false });
      row?.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Le focus arrive sur une ligne (Tab) : elle devient le curseur, sans changer la sélection. */
  protected onRowFocus(entry: Entry): void {
    if (this.store.selection().cursor !== entry.id) this.store.selection.update(s => ({ ...s, cursor: entry.id, anchor: s.anchor ?? entry.id }));
  }

  // ── Colonnes ───────────────────────────────────────────────────────────

  protected sortBy(key: SortKey): void { this.store.toggleSort(key); }

  protected ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    const s = this.store.sort();
    return s.key !== key ? 'none' : s.dir === 'asc' ? 'ascending' : 'descending';
  }

  protected runAction(action: FileAction): void { this.store.run(action); }
}
