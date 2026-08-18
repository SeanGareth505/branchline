import {
  handleTitlebarMouseDown,
  isInteractiveTitlebarTarget,
  isNoDragTitlebarTarget,
} from './window-chrome';

describe('window-chrome', () => {
  it('treats buttons as interactive titlebar targets', () => {
    const button = document.createElement('button');
    document.body.append(button);
    expect(isInteractiveTitlebarTarget(button)).toBeTrue();
    button.remove();
  });

  it('treats chrome tool regions as no-drag targets', () => {
    const host = document.createElement('div');
    host.className = 'chrome-left';
    const child = document.createElement('span');
    host.append(child);
    document.body.append(host);
    expect(isNoDragTitlebarTarget(child)).toBeTrue();
    host.remove();
  });

  it('ignores titlebar mouse down on interactive targets', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const event = new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2 });
    spyOn(event, 'preventDefault');
    Object.defineProperty(event, 'target', { value: button });
    handleTitlebarMouseDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    button.remove();
  });
});
