import { applyWindowControlSide, detectWindowControlSide } from './window-controls';

describe('window controls', () => {
  it('puts traffic lights on the left on macOS', () => {
    expect(detectWindowControlSide('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      'macos',
    );
  });

  it('puts caption buttons on the right on Windows', () => {
    expect(detectWindowControlSide('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
  });

  it('leaves other platforms unchanged', () => {
    expect(detectWindowControlSide('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('other');
  });

  it('stamps the control side on the document root', () => {
    const root = document.createElement('html');
    applyWindowControlSide('macos', root);
    expect(root.getAttribute('data-window-controls')).toBe('macos');
  });
});
