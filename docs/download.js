const OWNER = 'SeanGareth505';
const REPO = 'branchline';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const LATEST = `https://github.com/${OWNER}/${REPO}/releases/latest`;

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

  if (isAndroid) return { id: 'android', label: 'Android', arch };
  if (isMac) return { id: 'mac', label: 'macOS', arch };
  if (isWin) return { id: 'windows', label: 'Windows', arch };
  if (isLinux) return { id: 'linux', label: 'Linux', arch };
  return { id: 'mac', label: 'macOS', arch: 'arm' };
}

function wire(el, asset, fallbackLabel) {
  if (!el) return;
  if (!asset) {
    el.href = LATEST;
    if (fallbackLabel) el.textContent = fallbackLabel;
    el.classList.add('missing');
    return;
  }
  el.href = asset.browser_download_url;
  el.classList.remove('missing');
}

function copyText(text) {
  return navigator.clipboard.writeText(text);
}

function renderHowto(platform) {
  const stepsEl = document.getElementById('steps');
  const actionsEl = document.getElementById('howto-actions');
  const pill = document.getElementById('platform-pill');
  pill.textContent = platform.label;

  const guides = {
    mac: {
      steps: [
        'Click <strong>Download for Mac</strong> above and open the <code>.dmg</code>.',
        'Drag <strong>Branchline</strong> into <strong>Applications</strong>.',
        'If macOS says it’s damaged, click <strong>Fix &amp; Open</strong> below (or run the command).',
      ],
      actions: [
        {
          label: 'Fix & Open helper',
          href: 'install-mac.command',
          download: true,
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
        'If SmartScreen appears, choose <strong>More info</strong> → <strong>Run anyway</strong>.',
        'Launch Branchline from the Start menu.',
      ],
      actions: [],
    },
    android: {
      steps: [
        'Download the <strong>APK</strong> on your phone.',
        'Allow install from this source when Android asks.',
        'Open the APK and install Branchline.',
      ],
      actions: [],
    },
    linux: {
      steps: [
        'Download the AppImage, <code>.deb</code>, or <code>.rpm</code> for your distro.',
        'For AppImage: <code>chmod +x Branchline*.AppImage && ./Branchline*.AppImage</code>',
        'For deb/rpm: install with your package manager.',
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
      if (action.download) a.setAttribute('download', '');
      actionsEl.appendChild(a);
    }
  }
}

async function loadLatest() {
  const primaryBtn = document.getElementById('primary-btn');
  const primaryMeta = document.getElementById('primary-meta');
  const platform = detectPlatform();

  document.querySelectorAll('.card').forEach((card) => {
    card.classList.toggle('recommended', card.dataset.platform === platform.id);
  });
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
      (n) => n === 'branchline-linux.AppImage'.toLowerCase(),
      (n) => n.endsWith('.appimage'),
      (n) => n.endsWith('.deb'),
      (n) => n.endsWith('.rpm'),
    ]);
    const apk = pickAsset(assets, [
      (n) => n === 'branchline-android.apk',
      (n) => n.endsWith('-android.apk'),
      (n) => n.endsWith('.apk'),
    ]);

    wire(document.getElementById('mac-arm-btn'), macArm, 'Apple Silicon');
    wire(document.getElementById('mac-intel-btn'), macIntel, 'Intel');
    wire(document.getElementById('win-btn'), win, 'Download Windows');
    wire(document.getElementById('linux-btn'), linux, 'Download Linux');
    wire(document.getElementById('apk-btn'), apk, 'Download APK');

    let primary = null;
    let primaryLabel = 'Download';

    if (platform.id === 'mac') {
      primary = platform.arch === 'intel' ? macIntel || macArm : macArm || macIntel;
      primaryLabel =
        platform.arch === 'intel' ? 'Download for Mac (Intel)' : 'Download for Mac (Apple Silicon)';
    } else if (platform.id === 'windows') {
      primary = win;
      primaryLabel = 'Download for Windows';
    } else if (platform.id === 'android') {
      primary = apk;
      primaryLabel = 'Download Android APK';
    } else {
      primary = linux;
      primaryLabel = 'Download for Linux';
    }

    if (primary) {
      primaryBtn.href = primary.browser_download_url;
      primaryBtn.textContent = primaryLabel;
      primaryMeta.textContent = `Latest ${release.tag_name} · ${primary.name}`;
    } else {
      primaryBtn.href = release.html_url;
      primaryBtn.textContent = `Get ${platform.label} build`;
      primaryMeta.textContent = `Latest ${release.tag_name} — open release assets`;
    }
  } catch (err) {
    primaryBtn.href = LATEST;
    primaryBtn.textContent = 'Open latest release';
    primaryMeta.textContent = 'Could not auto-detect assets — open GitHub Releases.';
    console.error(err);
  }
}

loadLatest();
