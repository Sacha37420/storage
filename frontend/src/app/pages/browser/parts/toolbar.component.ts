import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, computed, inject } from '@angular/core';

import { BrowserStore } from '../browser.store';
import { FileAction, actionsFor, shortcutLabel } from '../logic/actions';
import { IconComponent } from './icon.component';

/** Barre d'actions : mêmes entrées que le menu contextuel, lues dans la même table. */
@Component({
  selector: 'app-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="bar" role="toolbar" aria-label="Actions" [class.has-selection]="count() > 0">
      @if (count() > 0) {
        <span class="count" aria-live="polite">{{ count() }} sélectionné{{ count() > 1 ? 's' : '' }}</span>
      }
      @for (a of actions(); track a.id) {
        <button type="button" class="act" [class.danger]="a.danger" [attr.data-action]="a.id"
                [title]="a.shortcut ? a.label + ' (' + shortcutLabel(a.shortcut) + ')' : a.label"
                [attr.aria-label]="a.label"
                (click)="store.run(a)">
          <app-icon [name]="a.icon" />
          <span class="label">{{ a.short ?? a.label }}</span>
        </button>
      }
      @if (count() > 0) {
        <button type="button" class="act ghost" data-action="clear-selection" title="Désélectionner (Échap)"
                aria-label="Désélectionner" (click)="store.clearSelection()">
          <app-icon name="close" />
        </button>
      }
      @if (count() === 0 && !store.canWrite() && store.namespace()) {
        <span class="readonly"><app-icon name="lock" /> Lecture seule</span>
      }
      <span class="spacer"></span>
      <label class="filter">
        <app-icon name="search" />
        <input #filter type="search" placeholder="Filtrer ce dossier" aria-label="Filtrer ce dossier (touche /)"
               [value]="store.filter()" (input)="store.setFilter(filter.value)"
               (keydown.escape)="clearFilter(filter)" />
      </label>
    </div>
  `,
  styleUrl: './toolbar.component.scss',
})
export class ToolbarComponent {
  protected store = inject(BrowserStore);
  protected readonly shortcutLabel = shortcutLabel;
  protected readonly count = computed(() => this.store.selectedEntries().length);
  protected readonly actions = computed<FileAction[]>(() => actionsFor(this.store.actionContext(), 'bar'));

  @ViewChild('filter', { static: true }) private filterRef!: ElementRef<HTMLInputElement>;

  focusFilter(): void {
    this.filterRef.nativeElement.focus();
    this.filterRef.nativeElement.select();
  }

  protected clearFilter(input: HTMLInputElement): void {
    this.store.setFilter('');
    input.blur();
  }
}
