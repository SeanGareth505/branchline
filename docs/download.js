const OWNER = 'SeanGareth505';
const REPO = 'branchline';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const LATEST = `https://github.com/${OWNER}/${REPO}/releases/latest`;
const STABLE = {
  macArm: `${LATEST}/download/Branchline-mac-arm64.dmg`,
  macIntel: `${LATEST}/download/Branchline-mac-x64.dmg`,
  windows: `${LATEST}/download/Branchline-windows-setup.exe`,
  linux: `${LATEST}/download/Branchline-linux.AppImage`,
  linuxDeb: `${LATEST}/download/Branchline-linux.deb`,
};

const BUTTONS = [
  { id: 'mac-arm-btn', href: STABLE.macArm, label: 'Apple Silicon' },
  { id: 'mac-intel-btn', href: STABLE.macIntel, label: 'Intel' },
  { id: 'win-btn', href: STABLE.windows, label: 'Download Windows' },
  { id: 'linux-btn', href: STABLE.linux, label: 'AppImage' },
  { id: 'linux-deb-btn', href: STABLE.linuxDeb, label: 'Deb' },
];

function pickAsset(assets, tests) {
  for (const test of tests) {
    const hit = assets.find((a) => test(a.name.toLowerCase()));
    if (hit) return hit;
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

  let arch = 'arm';
  if (isMac) {
    const uaData = navigator.userAgentData;
    if (uaData && uaData.architecture === 'arm') arch = 'arm';
    else if (/Intel/.test(ua)) arch = 'intel';
    else arch = 'arm';
  }

  if (isMac) return { id: 'mac', label: 'macOS', arch };
  if (isWin) return { id: 'windows', label: 'Windows', arch };
  if (isLinux) return { id: 'linux', label: 'Linux', arch };
  return { id: 'mac', label: 'macOS', arch: 'arm' };
}

function primaryFor(platform) {
  if (platform.id === 'windows') {
    return { href: STABLE.windows, label: 'Download for Windows' };
  }
  if (platform.id === 'linux') {
    return { href: STABLE.linux, label: 'Download for Linux' };
  }
  if (platform.arch === 'intel') {
    return { href: STABLE.macIntel, label: 'Download for Mac (Intel)' };
  }
  return { href: STABLE.macArm, label: 'Download for Mac (Apple Silicon)' };
}

function setLink(el, href, label) {
  if (!el || !href) return;
  el.href = href;
  el.removeAttribute('aria-disabled');
  el.classList.remove('missing');
  if (label) el.textContent = label;
}

function applyStableLinks(platform) {
  for (const btn of BUTTONS) {
    setLink(document.getElementById(btn.id), btn.href);
  }
  const primary = primaryFor(platform);
  setLink(document.getElementById('primary-btn'), primary.href, primary.label);
  const meta = document.getElementById('primary-meta');
  if (meta) meta.textContent = 'Latest release · direct installer';
}

function wire(el, asset, fallbackHref, fallbackLabel) {
  if (!el) return;
  if (asset?.browser_download_url) {
    setLink(el, asset.browser_download_url, fallbackLabel);
    return;
  }
  setLink(el, fallbackHref || LATEST, fallbackLabel);
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

function guardHashClicks() {
  document.addEventListener(
    'click',
    (event) => {
      const link = event.target.closest?.('a');
      if (!link) return;
      const href = link.getAttribute('href');
      if (href !== '#' && href !== '') return;
      const fallback = BUTTONS.find((btn) => btn.id === link.id);
      if (!fallback) return;
      event.preventDefault();
      window.location.assign(fallback.href);
    },
    true,
  );
}

async function loadLatest() {
  const primaryBtn = document.getElementById('primary-btn');
  const primaryMeta = document.getElementById('primary-meta');
  const platform = detectPlatform();

  document.querySelectorAll('.card').forEach((card) => {
    card.classList.toggle('recommended', card.dataset.platform === platform.id);
  });
  applyStableLinks(platform);
  renderHowto(platform);

  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release = await res.json();
    const assets = release.assets || [];

    const macArm = pickAsset(assets, [
      (n) => n === 'branchline-mac-arm64.dmg',
      (n) => n.includes('aarch64') && n.endsWith('.dmg'),
      (n) => n.includes('arm64') && n.endsWith('.dmg'),
    ]);
    const macIntel = pickAsset(assets, [
      (n) => n === 'branchline-mac-x64.dmg',
      (n) => (n.includes('x64') || n.includes('x86_64')) && n.endsWith('.dmg'),
      (n) => n.endsWith('.dmg') && !n.includes('aarch64') && !n.includes('arm64'),
    ]);
    const win = pickAsset(assets, [
      (n) => n === 'branchline-windows-setup.exe',
      (n) => n.endsWith('-setup.exe'),
      (n) => n.endsWith('.msi'),
      (n) => n.endsWith('.exe'),
    ]);
    const linux = pickAsset(assets, [
      (n) => n === 'branchline-linux.appimage',
      (n) => n.endsWith('.appimage'),
    ]);
    const linuxDeb = pickAsset(assets, [
      (n) => n === 'branchline-linux.deb',
      (n) => n.endsWith('.deb'),
    ]);

    wire(document.getElementById('mac-arm-btn'), macArm, STABLE.macArm, 'Apple Silicon');
    wire(document.getElementById('mac-intel-btn'), macIntel, STABLE.macIntel, 'Intel');
    wire(document.getElementById('win-btn'), win, STABLE.windows, 'Download Windows');
    wire(document.getElementById('linux-btn'), linux, STABLE.linux, 'AppImage');
    wire(document.getElementById('linux-deb-btn'), linuxDeb, STABLE.linuxDeb, 'Deb');

    let primary = null;
    let primaryLabel = 'Download';

    if (platform.id === 'mac') {
      primary = platform.arch === 'intel' ? macIntel || macArm : macArm || macIntel;
      primaryLabel =
        platform.arch === 'intel' ? 'Download for Mac (Intel)' : 'Download for Mac (Apple Silicon)';
    } else if (platform.id === 'windows') {
      primary = win;
      primaryLabel = 'Download for Windows';
    } else {
      primary = linux;
      primaryLabel = 'Download for Linux';
    }

    const versionBadge = document.getElementById('version-badge');
    if (versionBadge && release.tag_name) {
      versionBadge.textContent = release.tag_name;
    }

    if (primary?.browser_download_url) {
      setLink(primaryBtn, primary.browser_download_url, primaryLabel);
      if (primaryMeta) primaryMeta.textContent = `Latest ${release.tag_name} · ${primary.name}`;
    } else {
      const fallback = primaryFor(platform);
      setLink(primaryBtn, fallback.href, fallback.label);
      if (primaryMeta) primaryMeta.textContent = `Latest ${release.tag_name} · direct installer`;
    }
  } catch (err) {
    applyStableLinks(platform);
    console.error(err);
  }
}

guardHashClicks();
loadLatest();
