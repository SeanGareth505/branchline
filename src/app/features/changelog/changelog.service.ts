import { Injectable } from '@angular/core';
import type { CommitInfo, TagInfo } from '../../core/models';

export type ChangelogFormat = 'keepachangelog' | 'conventional' | 'release' | 'plain';

export type ChangelogRangePreset = 'since-latest-tag' | 'between-tags' | 'compare' | 'selection' | 'custom';

export interface ChangelogOptions {
  format: ChangelogFormat;
  version: string;
  title: string;
  includeAuthors: boolean;
  includeShas: boolean;
  excludeMerges: boolean;
  excludeChores: boolean;
  date: string;
}

export interface ParsedCommit {
  commit: CommitInfo;
  type: string;
  scope: string | null;
  breaking: boolean;
  summary: string;
  section: ChangelogSection;
}

export type ChangelogSection =
  | 'Added'
  | 'Changed'
  | 'Fixed'
  | 'Deprecated'
  | 'Removed'
  | 'Security'
  | 'Breaking'
  | 'Other';

export interface ChangelogResult {
  markdown: string;
  commits: ParsedCommit[];
  fromLabel: string;
  toLabel: string;
}

const TYPE_SECTION: Record<string, ChangelogSection> = {
  feat: 'Added',
  feature: 'Added',
  add: 'Added',
  fix: 'Fixed',
  bugfix: 'Fixed',
  docs: 'Changed',
  doc: 'Changed',
  style: 'Changed',
  refactor: 'Changed',
  perf: 'Changed',
  performance: 'Changed',
  improve: 'Changed',
  enhancement: 'Changed',
  chore: 'Other',
  build: 'Other',
  ci: 'Other',
  test: 'Other',
  tests: 'Other',
  revert: 'Changed',
  deprecate: 'Deprecated',
  deprecated: 'Deprecated',
  remove: 'Removed',
  removed: 'Removed',
  security: 'Security',
  breaking: 'Breaking',
};

const SECTION_ORDER: ChangelogSection[] = [
  'Breaking',
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
  'Other',
];

const CONVENTIONAL_RE =
  /^(?<type>[a-z][a-z0-9-]*)(?<scope>\([^)]+\))?(?<breaking>!)?:\s*(?<summary>.+)$/i;

@Injectable({ providedIn: 'root' })
export class ChangelogService {
  sortTagsNewestFirst(tags: TagInfo[], commits: CommitInfo[]): TagInfo[] {
    const order = new Map(commits.map((c, i) => [c.sha, i]));
    return [...tags].sort((a, b) => {
      const ai = order.get(a.sha) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b.sha) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  latestTag(tags: TagInfo[], commits: CommitInfo[]): TagInfo | null {
    const sorted = this.sortTagsNewestFirst(tags, commits);
    return sorted[0] ?? null;
  }

  suggestVersion(tags: TagInfo[], commits: CommitInfo[]): string {
    const latest = this.latestTag(tags, commits)?.name ?? '';
    const match = latest.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return '1.0.0';
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const range = this.commitsBetween(commits, latest ? this.latestTag(tags, commits)?.sha ?? null : null, null);
    const hasBreaking = range.some((c) => this.parseCommit(c).breaking);
    const hasFeat = range.some((c) => {
      const p = this.parseCommit(c);
      return p.section === 'Added';
    });
    if (hasBreaking) return `${major + 1}.0.0`;
    if (hasFeat) return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }

  todayIso(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  commitsBetween(
    commits: CommitInfo[],
    fromSha: string | null,
    toSha: string | null,
  ): CommitInfo[] {
    if (!commits.length) return [];

    let start = 0;
    if (toSha) {
      const idx = commits.findIndex((c) => this.shaMatch(c.sha, toSha));
      start = idx >= 0 ? idx : 0;
    }

    let end = commits.length;
    if (fromSha) {
      const idx = commits.findIndex((c) => this.shaMatch(c.sha, fromSha));
      end = idx >= 0 ? idx : commits.length;
    }

    if (end < start) {
      const tmp = start;
      start = end;
      end = tmp;
    }

    return commits.slice(start, end);
  }

  parseCommit(commit: CommitInfo): ParsedCommit {
    const raw = (commit.subject || commit.message || '').trim();
    const firstLine = raw.split('\n')[0]?.trim() ?? '';
    const match = firstLine.match(CONVENTIONAL_RE);
    const type = match?.groups?.['type']?.toLowerCase() ?? '';
    const scope = match?.groups?.['scope']?.replace(/[()]/g, '') || null;
    const breaking =
      !!match?.groups?.['breaking'] ||
      /\bBREAKING CHANGE\b/i.test(commit.message) ||
      /\bBREAKING CHANGE\b/i.test(commit.subject);
    const summary = (match?.groups?.['summary'] ?? firstLine).trim();
    let section = TYPE_SECTION[type] ?? 'Other';
    if (breaking) section = 'Breaking';
    if (/^merge\b/i.test(firstLine)) section = 'Other';
    return { commit, type: type || 'other', scope, breaking, summary, section };
  }

  generate(
    commits: CommitInfo[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): ChangelogResult {
    let parsed = commits.map((c) => this.parseCommit(c));

    if (options.excludeMerges) {
      parsed = parsed.filter((p) => !/^merge\b/i.test(p.commit.subject || p.commit.message));
    }
    if (options.excludeChores) {
      parsed = parsed.filter((p) => p.type !== 'chore' && p.type !== 'ci' && p.type !== 'build');
    }

    const markdown = this.render(parsed, options, fromLabel, toLabel);
    return { markdown, commits: parsed, fromLabel, toLabel };
  }

  private render(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    switch (options.format) {
      case 'keepachangelog':
        return this.renderKeepAChangelog(parsed, options, fromLabel, toLabel);
      case 'conventional':
        return this.renderConventional(parsed, options, fromLabel, toLabel);
      case 'release':
        return this.renderReleaseNotes(parsed, options, fromLabel, toLabel);
      default:
        return this.renderPlain(parsed, options, fromLabel, toLabel);
    }
  }

  private renderKeepAChangelog(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim() || 'Unreleased';
    const lines: string[] = [
      `## [${version}] - ${options.date}`,
      '',
      `> Changes from \`${fromLabel}\` to \`${toLabel}\``,
      '',
    ];

    const groups = this.groupBySection(parsed);
    for (const section of SECTION_ORDER) {
      const items = groups.get(section);
      if (!items?.length) continue;
      lines.push(`### ${section}`, '');
      for (const item of items) {
        lines.push(`- ${this.bullet(item, options)}`);
      }
      lines.push('');
    }

    if (parsed.length === 0) {
      lines.push('_No commits in this range._', '');
    }

    return lines.join('\n').trimEnd() + '\n';
  }

  private renderConventional(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim() || 'Unreleased';
    const lines: string[] = [
      `# ${version}`,
      '',
      `Range: \`${fromLabel}\` → \`${toLabel}\` · ${options.date}`,
      '',
    ];

    const byType = new Map<string, ParsedCommit[]>();
    for (const item of parsed) {
      const key = item.type || 'other';
      const list = byType.get(key) ?? [];
      list.push(item);
      byType.set(key, list);
    }

    const order = [
      'feat',
      'fix',
      'perf',
      'refactor',
      'docs',
      'test',
      'build',
      'ci',
      'chore',
      'other',
    ];
    const keys = [...byType.keys()].sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
    });

    for (const key of keys) {
      const items = byType.get(key)!;
      lines.push(`## ${key}`, '');
      for (const item of items) {
        const scope = item.scope ? `**${item.scope}:** ` : '';
        lines.push(`- ${scope}${this.bullet(item, options)}`);
      }
      lines.push('');
    }

    if (parsed.length === 0) {
      lines.push('_No commits in this range._', '');
    }

    return lines.join('\n').trimEnd() + '\n';
  }

  private renderReleaseNotes(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const title = options.title.trim() || `Release ${options.version.trim() || 'notes'}`;
    const lines: string[] = [
      `# ${title}`,
      '',
      `**Date:** ${options.date}  `,
      `**Range:** \`${fromLabel}\` → \`${toLabel}\``,
      '',
    ];

    const highlights = parsed.filter((p) => p.section === 'Breaking' || p.section === 'Added');
    const fixes = parsed.filter((p) => p.section === 'Fixed');
    const improvements = parsed.filter(
      (p) => p.section === 'Changed' || p.section === 'Deprecated' || p.section === 'Removed',
    );
    const security = parsed.filter((p) => p.section === 'Security');
    const other = parsed.filter((p) => p.section === 'Other');

    const pushGroup = (heading: string, items: ParsedCommit[]) => {
      if (!items.length) return;
      lines.push(`## ${heading}`, '');
      for (const item of items) {
        lines.push(`- ${this.bullet(item, options)}`);
      }
      lines.push('');
    };

    pushGroup('Highlights', highlights);
    pushGroup('Improvements', improvements);
    pushGroup('Fixes', fixes);
    pushGroup('Security', security);
    pushGroup('Other', other);

    if (parsed.length === 0) {
      lines.push('_No commits in this range._', '');
    }

    lines.push('---', '', `Generated with Branchline.`, '');
    return lines.join('\n').trimEnd() + '\n';
  }

  private renderPlain(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim() || 'Unreleased';
    const lines: string[] = [
      `${version} (${options.date})`,
      `${fromLabel} → ${toLabel}`,
      '',
    ];
    for (const item of parsed) {
      lines.push(`• ${this.bullet(item, options)}`);
    }
    if (parsed.length === 0) {
      lines.push('• No commits in this range.');
    }
    lines.push('');
    return lines.join('\n');
  }

  private groupBySection(parsed: ParsedCommit[]): Map<ChangelogSection, ParsedCommit[]> {
    const map = new Map<ChangelogSection, ParsedCommit[]>();
    for (const item of parsed) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    return map;
  }

  private bullet(item: ParsedCommit, options: ChangelogOptions): string {
    let text = item.summary;
    if (item.breaking && item.section !== 'Breaking') {
      text = `**BREAKING** ${text}`;
    }
    const bits: string[] = [];
    if (options.includeShas) bits.push(`\`${item.commit.shortSha}\``);
    if (options.includeAuthors && item.commit.author) bits.push(`@${item.commit.author}`);
    if (bits.length) text = `${text} (${bits.join(', ')})`;
    return text;
  }

  private shaMatch(a: string, b: string): boolean {
    if (!a || !b) return false;
    return a === b || a.startsWith(b) || b.startsWith(a.slice(0, 7)) || a.startsWith(b.slice(0, 7));
  }
}
