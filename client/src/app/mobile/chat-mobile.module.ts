import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule, Routes } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { UiModule } from '../ui/ui.module';
import { SharedChatModule } from '../chat/shared-chat.module';

import { MobileShellComponent } from './shell/mobile-shell.component';
import { MobileTabBarComponent } from './tab-bar/mobile-tab-bar.component';
import { MobileChatsComponent } from './chats/mobile-chats.component';
import { MobileCallsComponent } from './calls/mobile-calls.component';
import { MobilePeopleComponent } from './people/mobile-people.component';
import { MobileProfileComponent } from './profile/mobile-profile.component';
import { MobileThreadComponent } from './thread/mobile-thread.component';

const routes: Routes = [{
  path: '', component: MobileShellComponent,
  children: [
    { path: 'chats', component: MobileChatsComponent },
    { path: 'calls', component: MobileCallsComponent },
    { path: 'people', component: MobilePeopleComponent },
    { path: 'profile', component: MobileProfileComponent },
    { path: 'c/:key', component: MobileThreadComponent },
    { path: '', redirectTo: 'chats', pathMatch: 'full' },
  ],
}];

@NgModule({
  declarations: [
    MobileShellComponent, MobileTabBarComponent, MobileChatsComponent,
    MobileCallsComponent, MobilePeopleComponent, MobileProfileComponent,
    MobileThreadComponent,
  ],
  imports: [CommonModule, FormsModule, MatIconModule, UiModule, SharedChatModule, RouterModule.forChild(routes)],
})
export class ChatMobileModule {}
