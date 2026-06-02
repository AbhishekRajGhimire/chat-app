import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { UiModule } from '../ui/ui.module';
import { MessageThreadComponent } from './message-thread/message-thread.component';

/**
 * Presentational chat pieces shared between the desktop host and (later) the
 * mobile module. Declares + exports `MessageThreadComponent`; the mobile module
 * will import this same module to render messages identically.
 */
@NgModule({
  declarations: [MessageThreadComponent],
  imports: [CommonModule, FormsModule, MatIconModule, UiModule],
  exports: [MessageThreadComponent],
})
export class SharedChatModule {}
