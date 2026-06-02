import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SwipeBackDirective } from './swipe-back.directive';
import { SwipeToReplyDirective } from './swipe-to-reply.directive';
import { PullToRefreshDirective } from './pull-to-refresh.directive';
import { LongPressDirective } from './long-press.directive';
const D = [SwipeBackDirective, SwipeToReplyDirective, PullToRefreshDirective, LongPressDirective];
@NgModule({ declarations: D, exports: D, imports: [CommonModule] })
export class GesturesModule {}
