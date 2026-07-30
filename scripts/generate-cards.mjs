#!/usr/bin/env node
/**
 * Generates the profile card system in assets/ from real GitHub data.
 *
 *   node scripts/generate-cards.mjs
 *
 * Env:
 *   GH_TOKEN / GITHUB_TOKEN   required
 *   GH_USER                   defaults to Lonergun141
 *
 * Everything is committed SVG rather than a hosted card service. That is not
 * only about taste: github-readme-stats answers 503, github-profile-trophy
 * answers 402, and streak-stats is slow enough that GitHub's camo proxy times
 * it out at 504 — all three render as broken images on a profile.
 *
 * Two rules the whole file depends on:
 *   1. Motion is SMIL only. Chrome renders an SVG loaded as <img> with CSS
 *      keyframes frozen at t=0, so a `from { opacity: 0 }` makes text vanish.
 *      This is what silently hid the title on the banner service this replaces.
 *   2. No webfonts. An <img>-loaded SVG cannot fetch one, so the type system is
 *      built from system stacks — a heavy tight display face for the name and
 *      monospace for every number and label.
 *
 * Each card is emitted dark and light for <picture> in the README.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USER = process.env.GH_USER || 'Lonergun141';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('Missing GH_TOKEN / GITHUB_TOKEN.');
  process.exit(1);
}

// ---------------------------------------------------------------- tokens

const THEMES = {
  dark: {
    surface: '#0D1117',
    panel: '#111722',
    hair: '#1F2733',
    ink: '#E6EDF3',
    muted: '#7D8899',
    signal: '#4C8DFF',
    trace: '#3FB950',
    traceSoft: 'rgba(63,185,80,0.26)',
    flare: '#F0A93B',
    link: '#58A6FF',
  },
  light: {
    surface: '#FFFFFF',
    panel: '#F6F8FA',
    hair: '#D8DEE6',
    ink: '#1F2328',
    muted: '#59636E',
    signal: '#0B65D8',
    trace: '#1A7F37',
    traceSoft: 'rgba(26,127,55,0.20)',
    flare: '#B26206',
    link: '#0969DA',
  },
};

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const WIDE = 840; // full-column card
const HALF = 410; // paired card
const PAD = 22;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s, max = 30) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const num = (n) => n.toLocaleString('en-US');

/**
 * Micro-label: monospace, uppercase, wide tracking. The utility voice.
 * Tracking tightens for labels that have to fit inside a tile.
 */
const eyebrow = (t, x, y, text, anchor = 'start', tracking = 2.2) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${MONO}" font-size="9.5" letter-spacing="${tracking}" fill="${t.muted}">${esc(text.toUpperCase())}</text>`;

/** Advance width of monospace text — used to place units beside a figure. */
const monoWidth = (text, size) => text.length * size * 0.6;

// ---------------------------------------------------------------- data

const QUERY = `
  query ($login: String!) {
    user(login: $login) {
      pullRequests { totalCount }
      contributionsCollection {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalRepositoriesWithContributedCommits
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }
        commitContributionsByRepository(maxRepositories: 10) {
          repository { nameWithOwner isPrivate }
          contributions { totalCount }
        }
      }
      repositories(
        first: 100
        ownerAffiliations: OWNER
        isFork: false
        privacy: PUBLIC
      ) {
        totalCount
        nodes {
          languages(first: 8, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }
`;

async function fetchData() {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-card-generator',
    },
    body: JSON.stringify({ query: QUERY, variables: { login: USER } }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.user;
}

/**
 * Top languages by bytes across public sources.
 *
 * Capped at five named slots + "Other" for readability, not neatness: PHP
 * (#4F5D95) beside CSS (#663399) fails the normal-vision separation floor
 * (ΔE 10.8, needs ≥ 15), so the tail folds into a neutral bucket. The five that
 * survive keep GitHub's canonical language colors — the cue readers already
 * know — and every slot is named in the legend, so nothing rides on color alone.
 */
function topLanguages(repoNodes, slots = 5) {
  const byName = new Map();
  for (const repo of repoNodes) {
    for (const { size, node } of repo.languages.edges) {
      const prev = byName.get(node.name);
      if (prev) prev.size += size;
      else byName.set(node.name, { name: node.name, color: node.color, size });
    }
  }

  const sorted = [...byName.values()].sort((a, b) => b.size - a.size);
  const head = sorted.slice(0, slots);
  const tail = sorted.slice(slots).reduce((sum, l) => sum + l.size, 0);
  if (tail > 0) head.push({ name: 'Other', color: '#8b949e', size: tail });

  const total = head.reduce((sum, l) => sum + l.size, 0) || 1;
  for (const l of head) l.pct = (l.size / total) * 100;
  return head;
}

const calendarDays = (calendar) =>
  calendar.weeks
    .flatMap((w) => w.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));

/**
 * Current and longest streak.
 *
 * The calendar reaches back 12 months, so "longest" is longest-in-window and the
 * card says so. A zero-contribution today does not break the current streak —
 * the day is not over — matching GitHub's own behaviour.
 */
function streaks(calendar) {
  const days = calendarDays(calendar);

  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i -= 1;
  let current = 0;
  for (; i >= 0 && days[i].contributionCount > 0; i -= 1) current += 1;

  return { current, longest };
}

// ---------------------------------------------------------------- chrome

const frame = (w, h, t, body, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
  <defs>${defs}</defs>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${t.surface}" stroke="${t.hair}" />
${body}
</svg>
`;

/** Blueprint hairline grid — the instrument housing every card sits in. */
const grid = (w, h, t, step = 30, opacity = 0.5) => {
  const lines = [];
  for (let x = step; x < w; x += step)
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" />`);
  for (let y = step; y < h; y += step)
    lines.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" />`);
  return `<g stroke="${t.hair}" stroke-width="0.5" opacity="${opacity}">${lines.join('')}</g>`;
};

// ---------------------------------------------------------------- cards

/**
 * Hero. The thesis is the signal trace: 53 weeks of real contribution volume
 * plotted under the name. Deliberately no hero number — the shape is the point,
 * and the totals belong on the readout card where they can be compared.
 */
function heroCard(user, theme) {
  const t = THEMES[theme];
  const W = 900;
  const H = 238;

  const weeks = user.contributionsCollection.contributionCalendar.weeks.map((w) =>
    w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0)
  );
  const peak = Math.max(...weeks, 1);

  const x0 = 30;
  const span = W - x0 * 2;

  // The wordmark is justified to the full span with lengthAdjust="spacing", so
  // it lands edge to edge whatever system font the reader has. Size is kept well
  // under the target width: tracking then opens up, and a wide font degrades to
  // ordinary tracking instead of overlapping glyphs.
  const NAME = 'CLYDE H. GEVERO';
  const nameSize = 84;
  const baseline = 162;
  const capTop = baseline - 60; // cap height at this size

  const wordmark = (extra = '') =>
    `<text x="${x0}" y="${baseline}" textLength="${span}" lengthAdjust="spacing" font-family="${SANS}" font-size="${nameSize}" font-weight="800" ${extra}>${NAME}</text>`;

  // Each week fills its slice of the letterforms from the baseline up, so the
  // name reads as a level meter of the year. The dim base keeps every letter
  // legible where a week was quiet, and the scale stays linear — the name really
  // does fill toward the right, because the work did.
  const slot = span / weeks.length;
  const meter = weeks
    .map((v, i) => {
      if (v === 0) return '';
      const h = (v / peak) * 60;
      const x = x0 + i * slot;
      const y = baseline - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(slot + 0.5).toFixed(1)}" height="${h.toFixed(1)}" fill="${t.trace}" /><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(slot + 0.5).toFixed(1)}" height="1.6" fill="${t.ink}" opacity="0.55" />`;
    })
    .join('');

  const zero = baseline + 3;
  const ticks = [0, 1, 2, 3, 4]
    .map((i) => {
      const x = x0 + (span / 4) * i;
      return `<line x1="${x.toFixed(1)}" y1="${zero}" x2="${x.toFixed(1)}" y2="${zero + 6}" stroke="${t.hair}" stroke-width="1" />`;
    })
    .join('');

  const defs = `
    <linearGradient id="veil" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${t.signal}" stop-opacity="0.10" />
      <stop offset="100%" stop-color="${t.signal}" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="shine" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${t.ink}" stop-opacity="0" />
      <stop offset="50%" stop-color="${t.ink}" stop-opacity="0.14" />
      <stop offset="100%" stop-color="${t.ink}" stop-opacity="0" />
    </linearGradient>
    <clipPath id="wordmark">${wordmark()}</clipPath>`;

  const body = `  ${grid(W, H, t, 30, 0.45)}
  <rect x="0" y="0" width="${W}" height="140" fill="url(#veil)" />

  ${eyebrow(t, x0, 52, 'Fullstack developer · UI/UX designer')}
  ${eyebrow(t, x0 + span, 52, 'Contributions per week · last 12 months', 'end')}

  <g clip-path="url(#wordmark)">
    <rect x="${x0}" y="${capTop}" width="${span}" height="60" fill="${t.ink}" opacity="${theme === 'dark' ? 0.3 : 0.32}" />
    ${meter}
    <rect x="0" y="${capTop}" width="150" height="60" fill="url(#shine)">
      <animate attributeName="x" from="${x0 - 150}" to="${x0 + span}" dur="7s" repeatCount="indefinite" />
    </rect>
  </g>

  <!-- The blue rule is the meter's zero line, not decoration: it sits exactly on
       the baseline the weekly levels are measured from. -->
  <line x1="${x0}" y1="${zero}" x2="${x0 + span}" y2="${zero}" stroke="${t.signal}" stroke-width="1.5" opacity="0.6" />
  ${ticks}
  <text x="${x0}" y="${zero + 42}" font-family="${MONO}" font-size="12.5" fill="${t.muted}">I design and build web and mobile products — interface, API, and the system underneath.</text>
  <!-- Says what a full letter means, and balances the description across the grid. -->
  ${eyebrow(t, x0 + span, zero + 42, `Peak ${peak} in one week`, 'end')}`;

  return frame(W, H, t, body, defs);
}

/** GitHub's profile "Activity overview" radar, rebuilt from the same numbers. */
function activityCard(user, theme) {
  const t = THEMES[theme];
  const c = user.contributionsCollection;
  const H = 300;

  const axes = [
    { key: 'Code review', value: c.totalPullRequestReviewContributions, dir: [0, -1] },
    { key: 'Issues', value: c.totalIssueContributions, dir: [1, 0] },
    { key: 'Pull requests', value: c.totalPullRequestContributions, dir: [0, 1] },
    { key: 'Commits', value: c.totalCommitContributions, dir: [-1, 0] },
  ];

  const total = axes.reduce((s, a) => s + a.value, 0) || 1;
  const peak = Math.max(...axes.map((a) => a.value)) || 1;

  const cx = 626;
  const cy = 152;
  const R = 74;

  for (const a of axes) {
    a.pct = Math.round((a.value / total) * 100);
    a.px = cx + a.dir[0] * R * (a.value / peak);
    a.py = cy + a.dir[1] * R * (a.value / peak);
  }

  // Faint 25/50/75% guides so the shape reads as a magnitude, not a decoration.
  const guides = [0.25, 0.5, 0.75, 1]
    .map(
      (f) =>
        `<polygon points="${cx},${cy - R * f} ${cx + R * f},${cy} ${cx},${cy + R * f} ${cx - R * f},${cy}" fill="none" stroke="${t.hair}" stroke-width="1" />`
    )
    .join('');

  const spokes = axes
    .map(
      (a) =>
        `<line x1="${cx}" y1="${cy}" x2="${cx + a.dir[0] * R}" y2="${cy + a.dir[1] * R}" stroke="${t.hair}" stroke-width="1" />`
    )
    .join('');

  const shape = `<polygon points="${axes.map((a) => `${a.px.toFixed(1)},${a.py.toFixed(1)}`).join(' ')}" fill="${t.traceSoft}" stroke="${t.trace}" stroke-width="1.6" stroke-linejoin="round" />`;

  const dots = axes
    .map(
      (a) =>
        `<circle cx="${a.px.toFixed(1)}" cy="${a.py.toFixed(1)}" r="3.6" fill="${t.trace}" stroke="${t.surface}" stroke-width="1.6" />`
    )
    .join('');

  // 0% stays unlabelled, the way GitHub's own chart leaves it.
  const label = (a, x, y, anchor) => {
    const parts = [];
    if (a.pct > 0)
      parts.push(
        `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${MONO}" font-size="13" font-weight="600" fill="${t.ink}">${a.pct}%</text>`
      );
    parts.push(eyebrow(t, x, a.pct > 0 ? y + 14 : y + 4, a.key, anchor));
    return parts.join('');
  };

  const [review, issues, prs, commits] = axes;
  const labels = [
    label(review, cx, cy - R - 26, 'middle'),
    label(issues, cx + R + 16, cy - 2, 'start'),
    label(prs, cx, cy + R + 28, 'middle'),
    label(commits, cx - R - 16, cy - 2, 'end'),
  ].join('');

  const repos = c.commitContributionsByRepository
    .filter((r) => !r.repository.isPrivate)
    .slice(0, 5);
  const others = Math.max(0, c.totalRepositoriesWithContributedCommits - repos.length);

  const rows = repos
    .map((r, i) => {
      const y = 116 + i * 26; // clears the column rule at y=97
      const share = r.contributions.totalCount / (repos[0].contributions.totalCount || 1);
      return `<rect x="${PAD}" y="${y - 11}" width="${share * 300}" height="16" rx="3" fill="${t.trace}" opacity="0.10" />
  <text x="${PAD + 6}" y="${y}" font-family="${MONO}" font-size="11.5" fill="${t.link}">${esc(cut(r.repository.nameWithOwner.replace(/^Lonergun141\//i, '')))}</text>
  <text x="${PAD + 316}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11.5" fill="${t.muted}">${r.contributions.totalCount}</text>`;
    })
    .join('\n  ');

  const tail = others
    ? `<text x="${PAD + 6}" y="${116 + repos.length * 26}" font-family="${MONO}" font-size="11" fill="${t.muted}">+ ${others} more repositories</text>`
    : '';

  const body = `  ${grid(WIDE, H, t, 30, 0.4)}
  ${eyebrow(t, PAD, 40, 'Public · last 12 months')}
  <text x="${PAD}" y="66" font-family="${SANS}" font-size="17" font-weight="700" fill="${t.ink}">Where the contributions went</text>
  ${eyebrow(t, PAD + 6, 90, 'Most active')}
  ${eyebrow(t, PAD + 316, 90, 'Commits', 'end')}
  <line x1="${PAD}" y1="97" x2="${PAD + 316}" y2="97" stroke="${t.hair}" stroke-width="1" />
  ${rows}
  ${tail}
  <text x="${PAD}" y="${H - 22}" font-family="${MONO}" font-size="9.5" fill="${t.muted}">updated ${new Date().toISOString().slice(0, 10)}</text>
  <line x1="382" y1="26" x2="382" y2="${H - 26}" stroke="${t.hair}" stroke-width="1" />
  ${guides}${spokes}${shape}${dots}${labels}`;

  return frame(WIDE, H, t, body);
}

/** Readouts. Six magnitudes with nothing to compare shape-wise, so: no plot. */
function statsCard(user, theme) {
  const t = THEMES[theme];
  const c = user.contributionsCollection;
  const H = 330;
  const { current, longest } = streaks(c.contributionCalendar);

  const tileW = (HALF - PAD * 2 - 12) / 2;
  const tiles = [
    { value: num(c.contributionCalendar.totalContributions), label: 'Contributions · 12 mo' },
    { value: num(user.pullRequests.totalCount), label: 'Pull requests opened' },
    // The one warm accent in the system, spent on the number that is alive.
    { value: num(current), unit: current === 1 ? 'day' : 'days', label: 'Current streak', hot: true },
    { value: num(longest), unit: longest === 1 ? 'day' : 'days', label: 'Longest streak · 12 mo' },
    { value: num(user.repositories.totalCount), label: 'Public repositories' },
    { value: num(c.totalRepositoriesWithContributedCommits), label: 'Repos contributed to' },
  ];

  const body = tiles
    .map((tile, i) => {
      const x = PAD + (i % 2) * (tileW + 12);
      const y = 86 + Math.floor(i / 2) * 78;
      const color = tile.hot ? t.flare : t.ink;
      const unit = tile.unit
        ? `<text x="${(x + 12 + monoWidth(tile.value, 26) + 5).toFixed(1)}" y="${y + 38}" font-family="${MONO}" font-size="11" fill="${t.muted}">${tile.unit}</text>`
        : '';
      return `  <rect x="${x}" y="${y}" width="${tileW}" height="66" rx="7" fill="${t.panel}" stroke="${t.hair}" />
  <line x1="${x}" y1="${y + 10}" x2="${x}" y2="${y + 56}" stroke="${tile.hot ? t.flare : t.signal}" stroke-width="2" />
  <text x="${x + 12}" y="${y + 38}" font-family="${MONO}" font-size="26" font-weight="700" fill="${color}">${tile.value}</text>${unit}
  ${eyebrow(t, x + 12, y + 54, tile.label, 'start', 1.3)}`;
    })
    .join('\n');

  return frame(
    HALF,
    H,
    t,
    `  ${grid(HALF, H, t, 30, 0.4)}
  ${eyebrow(t, PAD, 40, 'Public profile')}
  <text x="${PAD}" y="66" font-family="${SANS}" font-size="17" font-weight="700" fill="${t.ink}">By the numbers</text>
${body}`
  );
}

/** One whole — the public codebase — split into named parts. */
function languagesCard(user, theme) {
  const t = THEMES[theme];
  const H = 330;
  const langs = topLanguages(user.repositories.nodes);

  const barX = PAD;
  const barY = 88;
  const barW = HALF - PAD * 2;
  const barH = 14;

  let cursor = barX;
  const segments = langs
    .map((l, i) => {
      const w = (l.pct / 100) * barW;
      const x = cursor;
      cursor += w;
      // 2px surface gap between fills; the last segment runs to the end.
      const drawW = i === langs.length - 1 ? Math.max(w, 1) : Math.max(w - 2, 1);
      return `<rect x="${x.toFixed(1)}" y="${barY}" width="${drawW.toFixed(1)}" height="${barH}" fill="${l.color}" />`;
    })
    .join('');

  const legend = langs
    .map((l, i) => {
      const y = 140 + i * 30;
      return `  <circle cx="${barX + 5}" cy="${y - 4}" r="5" fill="${l.color}" />
  <text x="${barX + 20}" y="${y}" font-family="${SANS}" font-size="13" fill="${t.ink}">${esc(l.name)}</text>
  <text x="${barX + barW}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="12.5" fill="${t.muted}">${l.pct.toFixed(1)}%</text>
  <line x1="${barX}" y1="${y + 10}" x2="${barX + barW}" y2="${y + 10}" stroke="${t.hair}" stroke-width="0.5" />`;
    })
    .join('\n');

  return frame(
    HALF,
    H,
    t,
    `  ${grid(HALF, H, t, 30, 0.4)}
  ${eyebrow(t, PAD, 40, 'Public repositories')}
  <text x="${PAD}" y="66" font-family="${SANS}" font-size="17" font-weight="700" fill="${t.ink}">Most used languages</text>
  <defs><clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" /></clipPath></defs>
  <g clip-path="url(#bar)">${segments}</g>
${legend}
  ${eyebrow(t, barX, H - 20, 'Share of bytes of code')}`
  );
}

// ---------------------------------------------------------------- run

const user = await fetchData();
await mkdir(resolve(ROOT, 'assets'), { recursive: true });

const cards = {
  hero: heroCard,
  'activity-overview': activityCard,
  stats: statsCard,
  languages: languagesCard,
};

for (const [name, build] of Object.entries(cards)) {
  for (const theme of Object.keys(THEMES)) {
    await writeFile(resolve(ROOT, `assets/${name}-${theme}.svg`), build(user, theme), 'utf8');
    console.log(`wrote assets/${name}-${theme}.svg`);
  }
}
