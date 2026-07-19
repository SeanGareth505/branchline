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

  let arch = 'unknown';
  if (isMac) {
    const isArm =
      (navigator.userAgentData &&
        Array.isArray(navigator.userAgentData.brands) &&
        false) ||
      /arm64|aarch64/i.test(ua) ||
      (typeof navigator.cpuClass === 'string' && /arm/i.test(navigator.cpuClass));
    // Apple Silicon Macs still report Intel in many browsers; prefer arm when available.
    if (isArm || (navigator.userAgentData && navigator.userAgentData.architecture === 'arm')) {
      arch = 'arm';
    } else if (/Intel/.test(ua)) {
      arch = 'intel';
    } else {
      arch = 'arm';
    }
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
    el.textContent = fallbackLabel || el.textContent;
    el.classList.add('missing');
    return;
  }
  el.href = asset.browser_download_url;
  el.classList.remove('missing');
}

async function loadLatest() {
  const primaryBtn = document.getElementById('primary-btn');
  const primaryMeta = document.getElementById('primary-meta');
  const platform = detectPlatform();

  document.querySelectorAll('.card').forEach((card) => {
    card.classList.toggle('recommended', card.dataset.platform === platform.id);
  });

  const macTip = document.getElementById('mac-tip');
  if (macTip) macTip.hidden = platform.id !== 'mac';

  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release = await res.json();
    const assets = release.assets || [];

    const macArm = pickAsset(assets, [
      (n) => n.includes('aarch64') && n.endsWith('.dmg'),
      (n) => n.includes('arm64') && n.endsWith('.dmg'),
      (n) => n === 'branchline-mac-arm64.dmg',
    ]);
    const macIntel = pickAsset(assets, [
      (n) => (n.includes('x64') || n.includes('x86_64')) && n.endsWith('.dmg'),
      (n) => n === 'branchline-mac-x64.dmg',
      (n) => n.endsWith('.dmg') && !n.includes('aarch64') && !n.includes('arm64'),
    ]);
    const win = pickAsset(assets, [
      (n) => n === 'branchline-windows-setup.exe',
      (n) => n.endsWith('-setup.exe'),
      (n) => n.endsWith('.msi'),
      (n) => n.endsWith('.exe'),
    ]);
    const linux = pickAsset(assets, [
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
