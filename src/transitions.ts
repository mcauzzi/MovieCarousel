let overlay: HTMLElement;

function waitForAnimation(el: HTMLElement): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      el.removeEventListener('animationend', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 500);
    el.addEventListener('animationend', done, { once: true });
  });
}

export function initTransitions(): void {
  overlay = document.createElement('div');
  overlay.id = 'transition-overlay';
  document.body.appendChild(overlay);
  document.body.classList.add('transitions-enabled');
}

export async function withTransition(callback: () => void): Promise<void> {
  if (!document.body.classList.contains('transitions-enabled')) {
    callback();
    return;
  }
  overlay.classList.add('t-enter');
  await waitForAnimation(overlay);
  overlay.classList.remove('t-enter');
  callback();
  overlay.classList.add('t-exit');
  await waitForAnimation(overlay);
  overlay.classList.remove('t-exit');
}
