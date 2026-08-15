const OWNER = 'SeanGareth505';
const REPO = 'branchline';
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=10`;
const LATEST = `https://github.com/${OWNER}/${REPO}/releases/latest`;

const MATCHERS = {
  macArm: [
    (n) => n === 'branchline-mac-arm64.dmg',
    (n) => n.includes('aarch64') && n.endsWith('.dmg'),
    (n) => n.includes('arm64') && n.endsWith('.dmg'),
  ],
  macIntel: [
    (n) => n === 'branchline-mac-x64.dmg',
    (n) => (n.includes('x64') || n.includes('x86_64')) && n.endsWith('.dmg') && !n.includes('arm'),
  ],
  windows: [
    (n) => n === 'branchline-windows-setup.exe',
    (n) => n.endsWith('-setup.exe'),
    (n) => n.endsWith('.msi'),
  ],
  linux: [(n) => n === 'branchline-linux.appimage', (n) => n.endsWith('.appimage')],
  linuxDeb: [(n) => n === 'branchline-linux.deb', (n) => n.endsWith('.deb')],
};

function pickAsset(assets, tests) {
  for (const test of tests) {
    const hit = assets.find((a) => test(a.name.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

function findAsset(releases, tests) {
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const asset = pickAsset(release.assets || [], tests);
    if (asset) return { release, asset };
  }
  return null;
}

function detectPlatform() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const isMac = /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(ua);
  const isWin = /Win/.test(platform) || /Windows/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isLinux = /Linux/.test(platform) && !isAndroid;

  if (isMac) return { id: 'mac', label: 'macOS', arch: 'arm' };
  if (isWin) return { id: 'windows', label: 'Windows', arch: 'x64' };
  if (isLinux) return { id: 'linux', label: 'Linux', arch: 'x64' };
  return { id: 'mac', label: 'macOS', arch: 'arm' };
}

async function detectMacArch() {
  try {
    const uaData = navigator.userAgentData;
    if (uaData?.getHighEntropyValues) {
      const { architecture } = await uaData.getHighEntropyValues(['architecture']);
      if (architecture === 'x86' || architecture === 'x86_64') return 'intel';
    }
  } catch {
    /* default Apple Silicon */
  }
  return 'arm';
}

function setLink(el, href, label) {
  if (!el || !href) return;
  el.href = href;
  el.removeAttribute('aria-disabled');
  el.classList.remove('missing');
  if (label) el.textContent = label;
}

function primaryChoice(platform, files) {
  if (platform.id === 'windows') {
    return { hit: files.windows, label: 'Download for Windows' };
  }
  if (platform.id === 'linux') {
    return { hit: files.linux, label: 'Download for Linux' };
  }
  if (platform.arch === 'intel') {
    return { hit: files.macIntel || files.macArm, label: 'Download for Mac (Intel)' };
  }
  return { hit: files.macArm || files.macIntel, label: 'Download for Mac (Apple Silicon)' };
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.left = '-9999px';
    document.body.appendChild(field);
    field.select();
    try {
      if (!document.execCommand('copy')) reject(new Error('copy failed'));
      else resolve();
    } catch (err) {
      reject(err);
    } finally {
      field.remove();
    }
  });
}

function helperUrl() {
  try {
    return new URL('install-mac.command', document.currentScript?.src || window.location.href).href;
  } catch {
    return 'install-mac.command';
  }
}

function renderHowto(platform) {
  const stepsEl = document.getElementById('steps');
  const actionsEl = document.getElementById('howto-actions');
  const pill = document.getElementById('platform-pill');
  if (pill) pill.textContent = platform.label;
  if (!stepsEl || !actionsEl) return;

  const guides = {
    mac: {
      steps: [
        'Click <strong>Download for Mac</strong> above and open the <code>.dmg</code>.',
        'Drag <strong>Branchline</strong> into <strong>Applications</strong>. If macOS says it is in the Bin, empty Trash first and replace the copy in Applications.',
        'Open it from Applications. This is a public beta — Gatekeeper may ask you to confirm the first launch.',
      ],
      actions: [
        {
          label: 'Fix & Open helper',
          href: helperUrl(),
          download: 'install-mac.command',
        },
        {
          label: 'Copy fix command',
          copy: 'xattr -cr /Applications/Branchline.app && open /Applications/Branchline.app',
        },
      ],
    },
    windows: {
      steps: [
        'Click <strong>Download for Windows</strong> and run the <code>.exe</code> installer.',
        'Launch Branchline from the Start menu. This is a public beta — SmartScreen may warn until the app is widely used.',
        'If SmartScreen appears, choose <strong>More info</strong> → <strong>Run anyway</strong>.',
      ],
      actions: [],
    },
    linux: {
      steps: [
        'Download the AppImage or <code>.deb</code> for your distro.',
        'For AppImage: <code>chmod +x Branchline*.AppImage && ./Branchline*.AppImage</code>',
        'For deb: install with your package manager.',
      ],
      actions: [],
    },
  };

  const guide = guides[platform.id] || guides.mac;
  stepsEl.innerHTML = guide.steps.map((s) => `<li>${s}</li>`).join('');
  actionsEl.innerHTML = '';

  for (const action of guide.actions) {
    if (action.copy) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn solid';
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        try {
          await copyText(action.copy);
          btn.textContent = 'Copied';
          setTimeout(() => (btn.textContent = action.label), 1400);
        } catch {
          btn.textContent = 'Copy failed';
        }
      });
      actionsEl.appendChild(btn);
    } else if (action.href) {
      const a = document.createElement('a');
      a.className = 'btn solid';
      a.href = action.href;
      a.textContent = action.label;
      if (action.download) a.setAttribute('download', action.download);
      actionsEl.appendChild(a);
    }
  }
}

function wireHit(id, hit, label) {
  const el = document.getElementById(id);
  if (!el) return;
  if (hit?.asset?.browser_download_url) {
    setLink(el, hit.asset.browser_download_url, label);
    return;
  }
  setLink(el, LATEST, label);
}

async function loadLatest() {
  const primaryBtn = document.getElementById('primary-btn');
  const primaryMeta = document.getElementById('primary-meta');
  const platform = detectPlatform();

  document.querySelectorAll('.card').forEach((card) => {
    card.classList.toggle('recommended', card.dataset.platform === platform.id);
  });
  renderHowto(platform);

  if (platform.id === 'mac') {
    platform.arch = await detectMacArch();
  }

  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const releases = await res.json();
    const published = Array.isArray(releases) ? releases.filter((r) => !r.draft) : [];
    const latest = published[0];

    const files = {
      macArm: findAsset(published, MATCHERS.macArm),
      macIntel: findAsset(published, MATCHERS.macIntel),
      windows: findAsset(published, MATCHERS.windows),
      linux: findAsset(published, MATCHERS.linux),
      linuxDeb: findAsset(published, MATCHERS.linuxDeb),
    };

    wireHit('mac-arm-btn', files.macArm, 'Apple Silicon');
    wireHit('mac-intel-btn', files.macIntel, 'Intel');
    wireHit('win-btn', files.windows, 'Download Windows');
    wireHit('linux-btn', files.linux, 'AppImage');
    wireHit('linux-deb-btn', files.linuxDeb, 'Deb');

    const choice = primaryChoice(platform, files);
    const versionBadge = document.getElementById('version-badge');
    const readyTag = choice.hit?.release?.tag_name;
    const latestTag = latest?.tag_name;
    const building = latestTag && readyTag && latestTag !== readyTag;

    if (versionBadge) {
      versionBadge.textContent = building ? `${latestTag} building` : readyTag || latestTag || '';
    }

    if (choice.hit?.asset?.browser_download_url) {
      setLink(primaryBtn, choice.hit.asset.browser_download_url, choice.label);
      if (primaryMeta) {
        primaryMeta.textContent = building
          ? `${latestTag} is still building — downloading ${readyTag}`
          : `${readyTag} · ${choice.hit.asset.name}`;
      }
    } else {
      setLink(primaryBtn, LATEST, 'Open latest release');
      if (primaryMeta) {
        primaryMeta.textContent = latestTag
          ? `${latestTag} is still building installers`
          : 'Open GitHub Releases';
      }
    }
  } catch (err) {
    setLink(primaryBtn, LATEST, 'Open latest release');
    if (primaryMeta) primaryMeta.textContent = 'Open GitHub Releases for installers.';
    console.error(err);
  }
}

loadLatest();
