import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../../core/api.service';
import { BrowserStore, extractError } from '../browser.store';
import { IconComponent } from './icon.component';

/** Volet des espaces : « Mes fichiers », arbre des partages, création d'un partage. */
@Component({
  selector: 'app-space-tree',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, FormsModule, RouterLink, IconComponent],
  templateUrl: './space-tree.component.html',
  styleUrl: './space-tree.component.scss',
})
export class SpaceTreeComponent {
  protected store = inject(BrowserStore);
  private api = inject(ApiService);

  /** Émis quand un lien est suivi : le tiroir mobile se referme. */
  readonly navigated = output<void>();

  protected creating = signal(false);
  protected newShareName = '';
  protected newShareParent = '';
  protected newShareError = signal<string | null>(null);

  /** Application qui gère un partage, d'après son propriétaire (voir BrowserStore.managedBy). */
  protected appOf(owner: string): string | null {
    return owner.startsWith('service:') ? owner.slice('service:'.length).replace(/-admin$/, '') : null;
  }

  protected submitNewShare(): void {
    const name = this.newShareName.trim().toLowerCase();
    if (!name) return;
    this.newShareError.set(null);
    this.api.createShare(name, this.newShareParent || null).subscribe({
      next: share => {
        this.store.refreshShares();
        this.newShareName = '';
        this.newShareParent = '';
        this.creating.set(false);
        this.store.goTo(share.name);
        this.navigated.emit();
      },
      error: err => this.newShareError.set(extractError(err)),
    });
  }
}
