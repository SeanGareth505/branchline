import { Injectable } from '@angular/core';
import type { CommitInfo, TagInfo } from '../../core/models';

export type ChangelogFormat =
  | 'release'
  | 'team'
  | 'credits'
  | 'engineering'
  | 'plain';

export type ChangelogRangePreset =
  | 'since-latest-tag'
  | 'between-tags'
  | 'compare'
  | 'selection'
  | 'custom';

export interface ChangelogOptions {
  format: ChangelogFormat;
  version: string;
  title: string;
  team: string;
  preparedBy: string;
  includeAuthors: boolean;
  includeShas: boolean;
  includeContributors: boolean;
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
    const range = this.commitsBetween(
      commits,
      latest ? (this.latestTag(tags, commits)?.sha ?? null) : null,
      null,
    );
    const hasBreaking = range.some((c) => this.parseCommit(c).breaking);
    const hasFeat = range.some((c) => this.parseCommit(c).section === 'Added');
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
      case 'team':
        return this.renderTeam(parsed, options, fromLabel, toLabel);
      case 'credits':
        return this.renderCredits(parsed, options, fromLabel, toLabel);
      case 'engineering':
        return this.renderEngineering(parsed, options, fromLabel, toLabel);
      case 'plain':
        return this.renderPlain(parsed, options, fromLabel, toLabel);
      default:
        return this.renderRelease(parsed, options, fromLabel, toLabel);
    }
  }

  private renderRelease(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim() || 'Unreleased';
    const lines: string[] = [`## [${version}] - ${options.date}`, ''];
    this.pushMeta(lines, options, fromLabel, toLabel);

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

    this.pushContributors(lines, parsed, options);
    return lines.join('\n').trimEnd() + '\n';
  }

  private renderTeam(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim();
    const team = options.team.trim();
    const title =
      options.title.trim() ||
      (team ? `${team} update` : version ? `Team update · ${version}` : 'Team update');
    const lines: string[] = [`# ${title}`, ''];
    this.pushMeta(lines, options, fromLabel, toLabel);

    const highlights = parsed.filter((p) => p.section === 'Breaking' || p.section === 'Added');
    const fixes = parsed.filter((p) => p.section === 'Fixed');
    const improvements = parsed.filter(
      (p) =>
        p.section === 'Changed' ||
        p.section === 'Deprecated' ||
        p.section === 'Removed' ||
        p.section === 'Security',
    );
    const other = parsed.filter((p) => p.section === 'Other');

    const pushGroup = (heading: string, items: ParsedCommit[]) => {
      if (!items.length) return;
      lines.push(`## ${heading}`, '');
      for (const item of items) {
        const who =
          options.includeAuthors && item.commit.author ? ` — _${item.commit.author}_` : '';
        lines.push(`- ${this.bullet(item, { ...options, includeAuthors: false })}${who}`);
      }
      lines.push('');
    };

    pushGroup('What shipped', highlights);
    pushGroup('Improvements', improvements);
    pushGroup('Fixes', fixes);
    pushGroup('Other', other);

    if (parsed.length === 0) {
      lines.push('_Nothing new in this range._', '');
    }

    this.pushContributors(lines, parsed, { ...options, includeContributors: true });
    if (options.preparedBy.trim()) {
      lines.push(`Prepared by **${options.preparedBy.trim()}**.`, '');
    }
    return lines.join('\n').trimEnd() + '\n';
  }

  private renderCredits(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim();
    const team = options.team.trim();
    const title =
      options.title.trim() ||
      (version ? `Made by · ${version}` : team ? `Made by ${team}` : 'Made by');
    const lines: string[] = [`# ${title}`, ''];
    this.pushMeta(lines, options, fromLabel, toLabel);

    const contributors = this.contributorStats(parsed);
    if (contributors.length) {
      lines.push('## Contributors', '');
      for (const person of contributors) {
        const commits = person.count === 1 ? '1 commit' : `${person.count} commits`;
        lines.push(`- **${person.name}** — ${commits}`);
      }
      lines.push('');
    } else {
      lines.push('_No contributors in this range._', '');
    }

    const highlights = parsed.filter((p) => p.section === 'Breaking' || p.section === 'Added');
    if (highlights.length) {
      lines.push('## Highlights', '');
      for (const item of highlights) {
        const who = item.commit.author ? ` (${item.commit.author})` : '';
        lines.push(`- ${this.bullet(item, { ...options, includeAuthors: false })}${who}`);
      }
      lines.push('');
    }

    if (options.preparedBy.trim()) {
      lines.push(`Curated by **${options.preparedBy.trim()}**.`, '');
    }
    if (team) {
      lines.push(`— ${team}`, '');
    }
    return lines.join('\n').trimEnd() + '\n';
  }

  private renderEngineering(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim() || 'Unreleased';
    const lines: string[] = [`# ${version}`, ''];
    this.pushMeta(lines, options, fromLabel, toLabel);

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

    this.pushContributors(lines, parsed, options);
    return lines.join('\n').trimEnd() + '\n';
  }

  private renderPlain(
    parsed: ParsedCommit[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): string {
    const version = options.version.trim() || 'Unreleased';
    const lines: string[] = [`${version} (${options.date})`, `${fromLabel} → ${toLabel}`, ''];
    if (options.team.trim()) lines.push(`Team: ${options.team.trim()}`, '');
    if (options.preparedBy.trim()) lines.push(`By: ${options.preparedBy.trim()}`, '');
    for (const item of parsed) {
      lines.push(`• ${this.bullet(item, options)}`);
    }
    if (parsed.length === 0) {
      lines.push('• No commits in this range.');
    }
    lines.push('');
    return lines.join('\n');
  }

  private pushMeta(
    lines: string[],
    options: ChangelogOptions,
    fromLabel: string,
    toLabel: string,
  ): void {
    if (options.team.trim()) {
      lines.push(`**Team:** ${options.team.trim()}  `);
    }
    if (options.preparedBy.trim()) {
      lines.push(`**Prepared by:** ${options.preparedBy.trim()}  `);
    }
    lines.push(`**Date:** ${options.date}  `);
    lines.push(`**Range:** \`${fromLabel}\` → \`${toLabel}\``, '');
  }

  private pushContributors(
    lines: string[],
    parsed: ParsedCommit[],
    options: ChangelogOptions,
  ): void {
    if (!options.includeContributors) return;
    const people = this.contributorStats(parsed);
    if (!people.length) return;
    lines.push('## Contributors', '');
    for (const person of people) {
      lines.push(`- ${person.name} (${person.count})`);
    }
    lines.push('');
  }

  private contributorStats(parsed: ParsedCommit[]): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const item of parsed) {
      const name = item.commit.author?.trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
