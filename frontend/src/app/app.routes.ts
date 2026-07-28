import { Routes } from '@angular/router';
import { BrowserComponent } from './pages/browser/browser.component';

export const routes: Routes = [
  { path: '**', component: BrowserComponent },
];
