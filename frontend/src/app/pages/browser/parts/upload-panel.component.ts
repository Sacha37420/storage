import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { BrowserStore } from '../browser.store';
import { formatSize } from '../logic/entries';
import { IconComponent } from './icon.component';

/** Panneau d'envois : un fichier par ligne, progression, annuler, relancer. */
@Component({
  selector: 'app-upload-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    @if (store.uploads().length > 0) {
      <section class="panel" aria-label="Envois">
        <header>
          <button type="button" class="title" (click)="open.set(!open())" [attr.aria-expanded]="open()">
            <span aria-live="polite">
              @if (s().active > 0) {
                Envoi : {{ s().done }}/{{ s().total }} — {{ s().percent }} %
              } @else if (s().failed > 0) {
                {{ s().failed }} envoi{{ s().failed > 1 ? 's' : '' }} en échec
              } @else {
                Envois terminés ({{ s().done }}/{{ s().total }})
              }
            </span>
          </button>
          @if (s().active > 0) {
            <button type="button" class="link" (click)="store.cancelAllUploads()">Tout annuler</button>
          } @else {
            <button type="button" class="link" (click)="store.clearFinishedUploads()">Fermer</button>
          }
        </header>
        @if (s().active > 0) { <progress class="global" [value]="s().percent" max="100" aria-label="Progression globale"></progress> }
        @if (open()) {
          <ul>
            @for (u of store.uploads(); track u.id) {
              <li [class]="u.status" [attr.data-status]="u.status">
                <div class="line">
                  <span class="name" [title]="u.path">{{ u.path }}</span>
                  <span class="meta">
                    @switch (u.status) {
                      @case ('queued') { en attente }
                      @case ('uploading') { {{ u.size ? pct(u.loaded, u.size) : 0 }} % }
                      @case ('done') { {{ formatSize(u.size) }} }
                      @case ('canceled') { annulé }
                      @case ('error') { échec }
                    }
                  </span>
                  @if (u.status === 'queued' || u.status === 'uploading') {
                    <button type="button" class="ico" (click)="store.cancelUpload(u.id)" [attr.aria-label]="'Annuler l\\'envoi de ' + u.name" title="Annuler">
                      <app-icon name="close" />
                    </button>
                  } @else if ((u.status === 'error' || u.status === 'canceled') && u.retryable) {
                    <button type="button" class="ico" (click)="store.retryUpload(u.id)" [attr.aria-label]="'Relancer l\\'envoi de ' + u.name" title="Relancer">
                      <app-icon name="retry" />
                    </button>
                  } @else {
                    <span class="ico-space"></span>
                  }
                </div>
                @if (u.status === 'uploading') { <progress [value]="u.loaded" [max]="u.size || 1"></progress> }
                @if (u.error) { <p class="err">{{ u.error }}</p> }
              </li>
            }
          </ul>
        }
      </section>
    }
  `,
  styleUrl: './upload-panel.component.scss',
})
export class UploadPanelComponent {
  protected store = inject(BrowserStore);
  protected readonly formatSize = formatSize;
  protected readonly open = signal(true);
  protected readonly s = this.store.uploadSummary;
  protected pct(loaded: number, size: number): number { return Math.min(100, Math.round((100 * loaded) / size)); }
}
