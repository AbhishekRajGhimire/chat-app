import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { UiModule } from '../ui/ui.module';
import { MessageThreadComponent } from './message-thread/message-thread.component';
import { GesturesModule } from '../mobile/gestures/gestures.module';
import { AttachmentTrayComponent } from './attachment-tray/attachment-tray.component';

/**
 * Presentational chat pieces shared between the desktop host and (later) the
 * mobile module. Declares + exports `MessageThreadComponent`; the mobile module
 * will import this same module to render messages identically.
 */
@NgModule({
  declarations: [MessageThreadComponent, AttachmentTrayComponent],
  imports: [CommonModule, FormsModule, MatIconModule, UiModule, GesturesModule],
  exports: [MessageThreadComponent, AttachmentTrayComponent, GesturesModule],
})
export class SharedChatModule {}
