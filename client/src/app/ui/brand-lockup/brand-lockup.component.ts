import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-brand-lockup',
  templateUrl: './brand-lockup.component.html',
  styleUrls: ['./brand-lockup.component.scss'],
})
export class BrandLockupComponent {
  /** When false, hides the tagline (e.g. narrow toolbar). */
  @Input() showTagline = true;
}
