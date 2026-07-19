const OWNER = 'SeanGareth505';
const REPO = 'branchline';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

function pickAsset(assets, tests) {
  for (const test of tests) {
    const hit = assets.find((a) => test(a.name.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

function setButton(id, asset, label) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!asset) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.href = asset.browser_download_url;
  if (label) el.textContent = label;
}

async function loadLatest() {
  const apkBtn = document.getElementById('apk-btn');
  const meta = document.getElementById('apk-meta');

  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release = await res.json();
    const assets = release.assets || [];

    const apk = pickAsset(assets, [
      (n) => n === 'branchline-android.apk',
      (n) => n.endsWith('-android.apk'),
      (n) => n.endsWith('.apk'),
    ]);
    const mac = pickAsset(assets, [
      (n) => n.includes('aarch64') && n.endsWith('.dmg'),
      (n) => n.endsWith('.dmg'),
    ]);
    const win = pickAsset(assets, [
      (n) => n.endsWith('-setup.exe'),
      (n) => n.endsWith('.msi'),
      (n) => n.endsWith('.exe'),
    ]);
    const linux = pickAsset(assets, [
      (n) => n.endsWith('.AppImage'),
      (n) => n.endsWith('.deb'),
      (n) => n.endsWith('.rpm'),
    ]);

    if (apk) {
      apkBtn.href = apk.browser_download_url;
      meta.textContent = `Latest ${release.tag_name} · ${apk.name}`;
    } else {
      apkBtn.href = release.html_url;
      meta.textContent = `Latest ${release.tag_name} — open release for assets`;
    }

    setButton('mac-btn', mac, 'macOS');
    setButton('win-btn', win, 'Windows');
    setButton('linux-btn', linux, 'Linux');
  } catch (err) {
    meta.textContent = 'Could not load latest release — open GitHub Releases instead.';
    apkBtn.href = `https://github.com/${OWNER}/${REPO}/releases/latest`;
    console.error(err);
  }
}

loadLatest();
