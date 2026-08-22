import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { formatDistanceToNowStrict } from 'date-fns';
import type { PrComment, PrCommentThread } from '../../../core/models';
import {
  prCodeThreads,
  prConversationThreads,
  prDiffHunkPreview,
  prReviewerInitials,
  prReviewStateLabel,
} from '../../../core/models';
import { identityColor } from '../../../shared/ui/identity-color';

@Component({
  selector: 'app-pr-comments',
  imports: [NgIcon],
  templateUrl: './pr-comments.html',
  styleUrl: './pr-comments.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrComments {
  readonly threads = input<PrCommentThread[]>([]);
  readonly loading = input(false);
  readonly error = input<string | null>(null);

  readonly conversation = computed(() => prConversationThreads(this.threads()));
  readonly code = computed(() => prCodeThreads(this.threads()));
  readonly identityColor = identityColor;
  readonly initials = prReviewerInitials;
  readonly hunkPreview = prDiffHunkPreview;
  readonly reviewLabel = prReviewStateLabel;

  time(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()) || !iso) return '';
    return formatDistanceToNowStrict(date, { addSuffix: true });
  }

  fileLabel(thread: PrCommentThread): string {
    const path = thread.path?.trim();
    if (!path) return 'Code comment';
    return thread.line ? `${path}:${thread.line}` : path;
  }

  body(comment: PrComment): string {
    return comment.body.trim();
  }
}
