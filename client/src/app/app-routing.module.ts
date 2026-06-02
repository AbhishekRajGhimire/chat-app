import { NgModule } from "@angular/core";
import { RouterModule, Routes } from "@angular/router";
import { ChatComponent } from "./chat/chat.component";
import { SigninComponent } from "./signin/signin.component";
import { SignupComponent } from "./signup/signup.component";
import { ProfileComponent } from "./profile/profile.component";
import { ShellRedirectComponent } from "./shell-redirect/shell-redirect.component";

const routes: Routes = [
  { path: '', component: ShellRedirectComponent, pathMatch: 'full' },
  { path: 'chat', component: ChatComponent },
  { path: 'm', loadChildren: () => import('./mobile/chat-mobile.module').then(m => m.ChatMobileModule) },
  { path: 'signin', component: SigninComponent },
  { path: 'signup', component: SignupComponent },
  { path: 'profile', component: ProfileComponent },
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule],
})
export class AppRoutingModule {}
