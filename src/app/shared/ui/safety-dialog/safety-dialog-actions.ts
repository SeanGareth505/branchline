import type { SafetyAnalysis } from '../../../core/models';

export function safetyShowsProceed(safety: SafetyAnalysis): boolean {
  if (safety.blocked || !safety.canProceed) return false;
  if (safety.action === 'forcePush') return true;
  return safety.proceedLabel !== safety.recommendedLabel;
}

export function safetyRecommendedIsKeep(safety: SafetyAnalysis): boolean {
  return safety.recommendedAction === 'keep';
}

export function safetyRecommendedButtonKind(
  safety: SafetyAnalysis,
): 'primary' | 'danger' {
  if (safety.blocked || safety.severity === 'info' || safetyRecommendedIsKeep(safety)) {
    return 'primary';
  }
  return 'danger';
}

export function safetySimpleFooterActions(safety: SafetyAnalysis): {
  showCancel: boolean;
  recommendedLabel: string;
  recommendedKeep: boolean;
  recommendedKind: 'primary' | 'danger';
  proceedLabel: string | null;
} {
  return {
    showCancel: !safety.blocked,
    recommendedLabel: safety.recommendedLabel,
    recommendedKeep: safetyRecommendedIsKeep(safety),
    recommendedKind: safetyRecommendedButtonKind(safety),
    proceedLabel: safetyShowsProceed(safety) ? safety.proceedLabel : null,
  };
}
